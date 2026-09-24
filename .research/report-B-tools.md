# 调研报告 B：工具系统（供第 2.1、3.1–3.5 章使用）

来源：ZCode CLI 源码调研。路径相对 `apps/zcode-cli/packages/core/src/`（除注明外）。

## 0. 总体架构：四层分层

```
模型层    ModelToolContract（registry.toContracts() 投影给 provider 的工具描述 + JSON Schema）
调度层    scheduler.ts   ToolScheduler：把一轮回来的 N 个 tool call 编排成 parallelGroups
执行层    executor/      ToolExecutorImpl + call-runner：校验→归一化→Hook→权限→handler→序列化
实现层    handlers/      每个工具一个 ToolEntry（元数据 + handler + 各种策略钩子）
```

关键文件（`tool/` 下）：

| 文件 | 职责 |
|---|---|
| `types.ts` | ToolMetadata / ToolEntry / ToolExecutionContext / ToolExecutionResult 等核心类型 |
| `registry.ts` | ToolRegistryImpl：注册、别名、toContracts 投影 |
| `scheduler.ts` | ToolScheduler：拓扑排序 + 并行分组 |
| `executor.ts` → `executor/impl.ts` | ToolExecutorImpl |
| `executor/call-runner.ts` | 单个工具调用的完整生命周期（约 700 行，执行流水线核心） |
| `executor/batch-runner.ts` | 批次并发（Promise.all 分块）+ 按调度组顺序执行 |
| `executor/timeout.ts` | ToolDeadline（可暂停的墙钟）+ resolveTimeoutMs |
| `executor/result-serialization.ts` | resultBudget 预算执行：截断 / 落盘 artifact |
| `executor/errors.ts` | 失败结果统一包 `<tool_use_error>` envelope |
| `handlers/index.ts` | `builtInTools` 数组 + `registerBuiltInTools` 特性门控 |
| `edit-matchers.ts` | Edit 的 8 级字符串匹配策略 |
| `diff.ts` | structuredPatch 生成（diff 库） |
| `read-file-state.ts` | 已读文件状态追踪 |
| `bash-timeout-policy.ts` | Bash 超时策略与环境变量覆盖 |
| `path-policy.ts` / `path-normalization.ts` | 路径解析与跨平台归一化 |
| `input-normalization.ts` | 模型入参 JSON 字符串兜底解析 + zod 预检 |
| `json-schema.ts` | 手写极简 JSON Schema 校验器（约 340 行） |
| `result-persistence-format.ts` | `<persisted-output>` 落盘预览信封 |
| `webfetch-preapproved.ts` | 90+ 个"预批准"文档域名白名单 |
| `compat.ts` | Agent/Task 互为别名等兼容映射 |

## 1. Tool 接口完整字段清单

### 1.1 `ToolMetadata`（静态安全声明）
```ts
export interface ToolMetadata {
  name: string;
  description?: string;
  modelInstructions?: readonly string[];
  allowedInPlanMode?: boolean;
  readOnly: boolean;               // 只读？
  destructive: boolean;            // 破坏性？
  concurrentSafe: boolean;         // 可与其它工具并行？
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffectScope: "none"|"session"|"workspace"|"network"|"system"|"userInteraction";
  riskLevel: "low"|"medium"|"high"|"critical";
  needsApproval: boolean;
  providerVisible?: boolean;       // false 则不进 provider 工具清单
  stopTurnOnSuccess?: boolean;     // 成功即终止 turn 的终态工具
}
```

### 1.2 `ToolEntry`（注册表条目）
= 契约 + 元数据 + handler + 策略钩子：`aliases?`、`metadata: ToolMetadata`、`handler: (input, context) => Promise<output>`、`validateInput?`（工具专属语义校验，Hook 前）、`resolveInput?`（入参→执行事实归一化，Hook 前）、`formatModelContent?`（output → 模型可见内容）、`resolveTimeoutBudgetMs?`（Bash 用）、`resolvePermissionCapability?`（Bash 只读命令改写权限旗标）、`inputSchema: JsonSchema`、`runtimeInputSchema?`（zod）、`timeout: ToolTimeoutPolicy`（`{defaultMs, maxMs, allowCallOverride, cleanupGraceMs}`）、`cancellation: ToolCancellationPolicy`。

### 1.3 `ToolExecutionContext`（handler 拿到的运行时上下文）
核心字段：`toolCallId`、`abortSignal`、`traceId/spanId/turnId/sessionId`、`telemetry`、`workingDirectory`（**跨调用持久**，Bash 可修改）、`workspaceRoot`、`runtimeScope: "main"|"subagent"`、`readFileState: ReadFileStateMap`（**会话级已读文件状态表**）、以及约 25 个可选 Port（`fileSystemPort`、`executionPort`、`httpClientPort`、`model`、`skillPort`、`subagentPort`、`sessionStore`、`artifactStore`、`emitEvent`…）。典型的 **Ports & Adapters**：handler 只依赖端口接口。

### 1.4 `ToolExecutionResult`
`{toolCallId, toolName, success, output, display, modelContent, serialization, error, durationMs, ...}`；`ToolResultSerialization` 记录 `{content, modelContent, originalBytes, returnedBytes, truncated, budgetStrategy, artifactPath?}`——"实际发给模型的字节"的唯一计量来源。

## 2. 注册表（registry.ts，148 行）
- 两个 Map：`tools`（canonical 名）与 `aliases`。`get(name)` 先查 alias 再查 canonical。
- **别名冲突规则**：canonical 永远优先；alias 冲突时拒绝新 alias 而不是覆盖——"兼容 alias 若静默覆盖 canonical/另一个 alias，会把一次工具调用路由到错误权限和 handler"。
- `toContracts()`：过滤 `providerVisible !== false`，metadata 投影为 `ModelToolContract`（`execute: undefined`——契约不含可执行体）。

## 3. 工具调度：scheduler.ts（并发模型核心）

```ts
// scheduler.ts L85-103
private canRunInParallel(tool: ToolDependency): boolean {
  const readOnly = tool.readOnly ?? (hasToolName ? this.readOnlyTools.has(tool.toolName!) : false);
  if (tool.destructive) return false;          // 破坏性 → 永不并行
  if (tool.concurrentSafe === true) return true;
  if (tool.concurrentSafe === false) return false;
  if (readOnly) return true;                   // 只读 → 并行
  return tool.sideEffectScope === "none";      // 显式无副作用 → 并行
}
```
默认只读集合：`READ_ONLY_TOOLS = { Read, Glob, Grep, WebSearch, WebFetch, TodoRead, TodoWrite, AskUserQuestion, Skill }`；`DEFAULT_MAX_CONCURRENCY = 10`。

runtime 侧收紧：`scheduleTools()` 把 readOnly 定义为 `metadata.readOnly && sideEffectScope === "none"`——TodoWrite 因 `sideEffectScope: "session"` 不会被判只读。

**编排算法**：① 拓扑排序（按 dependsOn，实际模型调用不用依赖，全落第 0 层）；② 分层分组：可并行工具依次进当前组，组满 10 个 flush；不可并行工具 flush 当前组后**独占一个单元素组**；③ 校验组内无依赖。

**所以"两个 Edit 互斥"不需要锁**：Edit 的 `concurrentSafe: false` → 每个 Edit 独占一组 → 按组顺序串行执行。多个 Read/Glob/Grep 进同一组用 Promise.all 并发。

**执行循环**（executor/batch-runner.ts）：AsyncGenerator，每组先 yield batch_start，`executeBatch`（按 maxConcurrency 分块 Promise.all），yield batch_complete。失败语义：某组结果带 `turnControl.stopTurnAfterResult` → 后续组工具标注 ToolCancelled 并 break。

## 4. 执行器：单次工具调用流水线（executor/call-runner.ts）

`executeToolCallImpl` 完整顺序：
1. registry 查找（含别名 canonical 化；未注册 → 错误 + `<tool_use_error>Error: No such tool available: X</tool_use_error>`）
2. 父级 abort 检查
3. 入参 JSON 字符串兜底 parse + zod `runtimeInputSchema.safeParse` 预检
4. 手写 JSON Schema 校验器校验 provider schema
5. `entry.validateInput`：工具专属语义校验——**必须在 Hook 前**，否则无效调用也白跑 PreToolUse 和权限
6. `entry.resolveInput`：把模型入参归一化成"将要发生的执行事实"，位置刻意在 Hook 之前——此后 Hook、权限、确认窗读到的都是同一份字节，**"确认 A 跑 B"在结构上不可能**
7. `runPreToolUseHooks`：deny → 权限拒绝；hook 改写 input → 重新过 schema 校验
8. `resolveToolPermission`：权限服务 + broker（可能弹窗）
9. `emitToolCallStarted`
10. `resolveTimeoutMs` + `ToolDeadline`
11. `executeWithTimeout(entry.handler)`；handler 可返回 `ToolHandlerFailure { result:false, errorCode, message }` 表达**可预期业务失败**（Edit 的"old_string 未找到"），转成 `<tool_use_error>message</tool_use_error>` envelope
12. `validateOutput`；`serializeOutput`（resultBudget）
13. `runPostToolUseHooks`（hook 的 additionalContext 受同一预算约束）
14. `createToolResultDisplay`、`emitToolCallResult`、后台任务登记

失败路径：业务失败保留裸 message 给 UI，模型可见内容统一包 `<tool_use_error>`。

## 5. 内置工具详解

`builtInTools` 共 37 个条目；特性门控注册（embeddedSearchEnabled 时隐藏 Glob/Grep）。

### Read（handlers/read.ts，526 行）
- 参数：`file_path`（绝对路径）、`offset?`、`limit?`、`pages?`（PDF）。
- 按扩展名分流：图片（jpg/png/gif/webp）/ 视频 / PDF / 纯文本。图片缩放压缩（base64 5MB、最长边 2000px、token 预算 25000），模型可见内容是 image block。
- 文本读取：无 limit 时 maxBytes=256KB；token 估算超 25,000 时二分找最大前缀行数（目标 85% 预算）生成 partial view 并附 `<system-reminder>` 提示"用 offset X 继续"。输出 `cat -n` 风格：`行号\t内容`。
- **去重**：同样 (path, offset, limit) 重复读，mtime+size 未变 → 返回 stub："Wasted call — file unchanged since your last Read..."，不再重复灌内容。
- 文件不存在时列目录找"编辑距离 ≤3"的相似文件名提示 "Did you mean X?"。
- readOnly、concurrentSafe、timeout 30s。

### Write（handlers/write.ts，377 行）
- 参数：`file_path`、`content`（整文件覆盖）。
- 已存在文件**强制 read-before-write + freshness 校验**；写入用 `writeTextFile({ atomic: true, createParents: true, expectedRevision })`——`expectedRevision` 是乐观并发控制，read 后被第三方改动会写失败。
- 输出 `type: "create"|"update"` + structuredPatch；模型可见内容是一句话 + `(file state is current in your context — no need to Read it back)`。
- maxOutputBytes 1MB；resultBudget maxModel 100KB。

### Edit（handlers/edit.ts + edit-matchers.ts）—— 见 §6、§7

### Bash（handlers/bash.ts，569 行）—— 见 §8

### Glob（handlers/glob.ts）
- 参数：`pattern`（如 `**/*.ts`）、`path?`。底层 `fileSystemPort.searchFiles({maxResults: 100})`，按修改时间排序。截断时附 "(Results are truncated...)"。上限 100 条/100KB。

### Grep（handlers/grep.ts）
- 参数：`pattern`（ripgrep 正则）、`path?`、`glob?`、`type?`、`output_mode: "content"|"files_with_matches"(默认)|"count"`、`-A/-B/-C`、`-i`、`multiline`、`head_limit`、`offset`。
- 底层 ripgrep。content 模式输出 `path:line:text`。模型字节上限 20KB。描述建议优先用本工具而非 Bash grep。

### WebFetch（handlers/webfetch.ts）
- 参数：`url`、`prompt`。
- 流程：URL 归一化（强制 HTTPS、上限 2000 字符）→ 抓取（响应体 10MB、重定向 10 跳；**跨宿主重定向不跟随**，返回 REDIRECT DETECTED 让模型用新 URL 重调）→ HTML→Markdown → 处理：
  - **预批准域名**（90+ 主机：MDN、docs.python.org、react.dev、nodejs.org 等）且内容 < 100,000 字符 → **直接返回原文，不过模型**；
  - 否则截到 100,000 字符 + prompt 交给小模型（maxOutputTokens 4096）提炼，非预批准站点带版权约束。
- 缓存：按 URL 15 分钟（总缓存 50MB）。
- readOnly、concurrentSafe、`sideEffectScope: "network"`、needsApproval true。

### WebSearch（handlers/websearch.ts）
- 参数：`query`、`allowed_domains?`、`blocked_domains?`。
- **provider-native**：发起独立 `model.streamText` 调用，带 provider 原生 web_search 工具契约（maxUses 8）。需要模型声明 `supportsNativeWebSearch`。描述动态生成以注入当前月份。

### TodoRead / TodoWrite（handlers/todo.ts）
- TodoWrite **整表替换**，每项 `{content, status: "pending"|"in_progress"|"completed", priority: "high"|"medium"|"low"}`；返回 `{oldTodos, todos, summary}`。
- metadata：`readOnly: true`（对文件系统）、`sideEffectScope: "session"`、`concurrentSafe: false`。

### Agent / Task（handlers/agent.ts）
- 同一实现两个名字。参数：`prompt`、`subagent_type?`、`description?`、`run_in_background?`、`model?`。
- 经 `subagentPort` 派发子代理；同步返回子代理最终消息 + agentId + `<usage>`；异步返回 `status: "async_launched"`。`MAX_AGENT_MODEL_BYTES = 120,000`。

### Skill（handlers/skill.ts）
- 参数：`skill`（支持 `plugin:skill`）、`args?`。经 `skillPort.loadSkill`（上限 100KB），包成 `<skill_content name="...">...</skill_content>`。

### AskUserQuestion（handlers/ask-user-question.ts）
- 参数：`questions[]`（每题 header/question/options[multiSelect]/preview）；**handler 要求输入已带 `answers`**——回答由权限/交互层收集后回填。`requiresUserInteraction: true`。

### TaskOutput / TaskStop
- TaskOutput：按 task_id 读后台任务输出，`block: true` 轮询等待（100ms 间隔）；默认截取 32,000 字符、最大 160,000、超 100,000 落盘。

## 6. Edit 工具：字符串匹配策略全解

### 6.1 八级策略链（edit-matchers.ts）
```ts
export function findEditMatch(input: { content; search; replaceAll }): EditMatchResult {
  const exact = collectExactCandidates(input.content, input.search);
  if (exact.length > 0) return toMatchResult("exact", exact);
  const strategies: EditMatchStrategy[] = [
    "quote_normalized",             // 1. 弯引号 ''"" → 直引号后匹配
    "line_number_prefix_stripped",  // 2. 剥掉 Read 输出的 "12:\t" 行号前缀
    "escape_normalized",            // 3. 把 \n \t \" 等可见转义还原成真字符
    "unicode_escape_normalized",    // 4. \uXXXX 还原
    "line_trimmed",                 // 5. 逐行 trim 后整块匹配
    "indentation_flexible",         // 6. 去公共缩进后整块匹配（≥2 行）
    "block_anchor",                 // 7. 首尾行锚定 + 中间行相似度 ≥0.8（≥3 行）
  ];
  for (const strategy of strategies) {
    if (input.replaceAll && BROAD_MATCHERS.has(strategy)) continue; // replaceAll 禁用宽松匹配
    const candidates = collectCandidates(strategy, input.content, input.search);
    if (candidates.length === 0) continue;
    return toMatchResult(strategy, candidates);
  }
  return { status: "not_found" };
}
```
- **严格到宽松逐级降级**，第一个命中即停；结果必须唯一（去重后 ≠1 → ambiguous）。
- `replaceAll: true` 跳过三种"宽"策略——防止把所有"长得差不多"的块全替换掉。
- `block_anchor` 用 Levenshtein 距离算行相似度，阈值 0.8。
- **回写补偿**：escape 匹配时 new_string 做同样 unescape；文件里是弯引号时替换文本回填弯引号。
- 删除场景：new_string 为空且 old_string 不以换行结尾 → 连换行一起删。
- 替换用 `content.replace(search, () => replacement)` 的**函数形式**——字符串 replacement 会把 `$$`/`$&` 当特殊 token。

### 6.2 多次出现
`replace_all === false` 且出现 >1 次 → 业务失败 `AMBIGUOUS_REPLACE (code 9)`，文案指导模型提供更多上下文。

### 6.3 diff 生成（diff.ts）
`structuredPatch`（npm diff 库，3 行上下文、5 秒超时）产出 `DiffHunk[]` 挂在输出上。**模型可见内容不含 diff**——Edit 成功的模型内容只是一句话，diff 是给 **UI** 展示的；runtime 还用它生成 CheckpointCreated 事件（文件回滚点）。

### 6.4 错误码表
`NO_CHANGE:1、FILE_EXISTS_NO_OLD_STRING:3、FILE_NOT_EXIST:4、NOTEBOOK_FILE:5、FILE_NOT_READ:6、STALE_FILE:7、OLD_STRING_NOT_FOUND:8、AMBIGUOUS_REPLACE:9、FILE_TOO_LARGE:10（1GB）、INVALID_PATH:13`。

## 7. read-file-state 机制

```ts
export interface ReadFileStateEntry {
  path: string;
  content: string;          // 读到时的完整文本
  offset?: number; limit?: number;
  isPartialView: boolean;   // true = 模型看到的是被截断的部分视图
  readAt: Date;
  sourceTool?: "Read"|"Write"|"Edit";
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}
```
三个目的：
1. **强制 read-before-edit/write**：没有记录 → `FILE_NOT_READ`（"File has not been read yet. Read it first before writing to it."）——防止模型凭想象盲改。
2. **stale 检测**：Read 后文件被用户/linter 改过 → `STALE_FILE`。
3. **Read 去重**：重复读未变文件返回 stub。

Edit 前校验（edit.ts L421-437）：
```ts
function getEditableReadStateFailure(filePath, currentRead, readFileState) {
  const lastRead = findEditableReadFileState(readFileState, filePath); // 该路径 readAt 最新一条
  if (!lastRead || lastRead.isPartialView) {
    return editFailure(EditErrorCode.FILE_NOT_READ, EDIT_NOT_READ_MESSAGE);
  }
  if (!hasReadStateChanged(lastRead, currentRead)) return undefined;
  // 双保险：严格整读且内容逐字节相同，即使 mtime 变了也放行
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return undefined;
  return editFailure(EditErrorCode.STALE_FILE, EDIT_STALE_MESSAGE);
}
```
`isPartialView`（token 截断产生的部分视图）**直接拒绝编辑**。

状态闭环：Read 成功 → 写 entry；**Edit/Write 成功后立即把新内容回写 entry** → 连续多次 Edit 不需重新 Read；**Bash 也参与**：模型用 cat/head/grep 看文件且输出未截断、文件 ≤10MB → 自动回填 readFileState；命令命中 formatter 特征（`--write/--fix/black/rustfmt...`）→ 提示 `[This command modified N files you've previously read: ... Call Read before editing.]`（最多列 5 个）。

resume 持久化：**会话恢复时只有带完整 freshness 元数据的历史记录才能恢复"已读"资格**。

## 8. Bash 工具深入

### 8.1 超时策略（bash-timeout-policy.ts）
```ts
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;   // 默认 2 分钟
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000; // 上限 10 分钟
```
env `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` 可覆盖；max ≥ default。Bash 是唯一 `timeout.allowCallOverride: true` 的内置工具；executor 实际墙钟 = 解析值 + `cleanupGraceMs: 6_000`（进程树优雅清理宽限）。

`ToolDeadline` 是**可暂停 deadline**：工具内部发起模型请求（如 WebFetch 的小模型）在进程级准入闸门排队时暂停计时——"超时守的是 provider 挂了，不是我们自己的队列长"。

### 8.2 后台运行
`run_in_background: true` → 立即返回 `{status: "backgrounded", backgroundTaskId, rawOutputPath}`；任务跨 turn 存活，退出时另起一轮通知 turn。**超时自动转后台**：非空命令且首 token 不是 `sleep` 即 eligible（sleep 就是为了等，不能转后台）。

### 8.3 输出截断与落盘
```ts
const MAX_INLINE_OUTPUT_BYTES = 30_000;      // 内联回传上限 30KB
const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5GB;
```
stdout/stderr 分别截 30KB；resultBudget `strategy: "artifact"`、`preview.direction: "tail"`（超预算保尾部——结论通常在末尾），超限整体落盘并给 `<persisted-output>` 信封 + 2,000 字符预览 + 路径。

结果后处理链：cwd 政策（越界重置回 workspaceRoot）→ 退出码语义解释 → **图片输出检测**（stdout 是 PNG 时转 image block）→ read-file-state 副作用。执行中持续发 `ToolCallProgress` 事件（elapsedMs/pid/stdoutBytes/outputPreview）。

### 8.4 跨平台（Windows）
- 路径比较统一走 `normalizeToolPathForComparison`：`/c/foo` → `C:\foo`、盘符大写、剥 `\\?\` 前缀、NFC 归一。
- **只读命令判定**：`bash-readonly-policy*` 系列（20+ 文件）对命令 argv 做白名单分析（git 只读子命令、ls/cat/grep 类、flag 级分析），命中则动态改写为 `readOnly: true, needsApproval: false`——**同一个 Bash 工具，git status 免审批、rm -rf 要审批**。

## 9. 工具结果的截断与持久化（executor/result-serialization.ts）

默认预算：`{maxInlineBytes: 100_000, maxModelBytes: 100_000, strategy: "truncate", preview: {direction: "head"}}`。流程：
1. `entry.formatModelContent(output)` 得到模型可见内容；空 → `"(Tool completed with no output)"` 占位；
2. 超预算且 strategy === "artifact" → 落盘（失败静默回退截断——"artifact 写入失败不应让一次成功的工具调用变成失败"）；
3. 落盘成功 → `<persisted-output>` 信封：
```
<persisted-output>
Output too large (1.2 MB). Full output saved to: /path/to/artifact

Preview (first 2 KB):
…（按换行对齐截取的 2000 字符预览）...
</persisted-output>
```
4. 否则直接截断，追加 `[Tool output truncated by resultBudget: ...]`。

各工具预算速查：Read 256KB/25k tokens；Edit/Write maxModel 100KB；Bash inline 30KB 落盘 5GB；Glob/Grep 100KB/20KB；WebFetch/WebSearch 100KB/20KB；Agent 120KB；TaskOutput 400KB。

## 10. 真实默认值/上限总表

| 常量 | 值 |
|---|---|
| Read 文件大小上限 | 256 KB |
| Read token 预算 | 25,000（partial 目标 85%=21,250） |
| Read 图片：输入/64/边长 | 20MB / 5MB / 2000px |
| Edit 可编辑文件上限 | 1 GB |
| Edit/Write 超时 | 30s 固定 |
| Bash 默认/最大超时 | 120s / 600s |
| Bash 清理宽限 | 6,000 ms |
| Bash 内联输出/落盘 | 30,000 B / 5 GB |
| Executor 默认超时兜底 | 300,000 ms |
| 调度最大并发 | 10 |
| 结果默认预算 | 100,000 B（head 截断） |
| 落盘预览 | 2,000 字符 |
| diff 上下文/超时 | 3 行 / 5,000 ms |
| Edit 宽松锚点相似度 | 0.8 |
| WebFetch 超时/URL/响应体/缓存 | 60s / 2,000 字符 / 10MB / 15min·50MB |
| Glob 结果上限 | 100 条/100KB |
| Grep 模型上限/超时 | 20,000 B / 30s |
| Skill 加载上限 | 100,000 B |
| Bash read-state 回填上限 | 10MB；stale 提示最多 5 个文件 |

## 11. 教学简化建议

1. **第一版只做 4 个工具**：read/write/edit/bash。一个 `Tool` 接口（name + description + inputSchema + handler + readOnly/concurrentSafe 两个布尔）就够。
2. **read-before-edit 用一张 Map 讲清楚**：`Map<path, {content, mtime, sizeBytes}>`，Edit 前检查"读过吗 + mtime 变了吗"。进阶小节：partial view 拒写、Edit 后回写状态、Bash cat 回填。
3. **Edit 匹配教"严格优先 + 逐级降级 + 唯一性"三原则**：教学版 exact + line_trimmed 两级 + 多处报错即可。切记教 `replace(search, () => replacement)` 这个 `$&` 陷阱。
4. **调度教"声明式并发安全"**：工具自带 concurrentSafe 标志，调度器只做一件事——可并行的进 Promise.all 组，不行的独占一组串行。"两个 Edit 天然互斥"不需要锁。
5. **截断教"预算三件套"**：inline 上限（Bash 30KB 保尾）、落盘阈值（>100KB 落盘 + 2KB 预览 + 路径）、token 预算（Read 25k）。
6. **Bash 教三件事**：超时（默认/上限/env 覆盖）、后台化（timeout 转后台比杀死聪明）、run_in_background + TaskOutput 轮询。
7. **最值得保留的"生产级"设计**：(a) `ToolHandlerFailure` 与异常的分离——业务失败是模型的输入，不是系统的崩溃；(b) 错误信息写给模型而非程序员（"Did you mean X?"、"(file state is current...)"）；(c) 幂等去重（file_unchanged stub）。
