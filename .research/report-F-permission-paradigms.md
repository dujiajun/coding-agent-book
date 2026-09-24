# 调研报告 F：权限模型、沙箱、Plan Mode、Todo、Goal、定时任务（供第 5.1–5.5 章使用）

来源：ZCode CLI 源码调研。路径相对 `apps/zcode-cli/`。

## 〇、总体架构一张图

```
模型 tool_call
   │
   ▼
ToolExecutor.resolveToolPermission (core/tool/executor/permission-flow.ts)
   │  ① PermissionService.checkPermission  ← 项目规则(SQLite) + 会话规则(内存) + 模式 + 工具能力声明
   │  ② PreToolUse hook 覆盖 / memory 文件特判
   ▼
allow ──────────────► 直接执行
deny  ──────────────► 错误 result 回模型
ask   ──► PermissionBrokerPort（端口）
            ├─ ManualPermissionBroker   （嵌入式/测试：pending map + resolvePermission）
            ├─ DenyPermissionBroker     （headless workflow：一律拒绝）
            └─ createProtocolInteractionBroker（bootstrap：反向 RPC 弹窗给桌面/TUI）
                    ▼
              用户选择 → PermissionBrokerResult { allow/deny/modify/escalate, permissionUpdates }
                    ▼
              项目规则持久化 / 会话规则入内存 → 执行
```

## 一、权限系统

### 1.1 权限模式（CollaborationMode）
`contracts/src/interfaces/session.port.ts:32`：
```ts
export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "auto";
```
| 模式 | 语义 |
|---|---|
| `build` | 默认模式，读工具直通、有副作用的要审批 |
| `edit` | 额外放行文件编辑（`permissionName==="edit"` 且 `sideEffectScope==="workspace"`），其余落回 build 判定 |
| `plan` | 只读模式（见第三章） |
| `yolo` | `checkPermission` 直接 allow（"Yolo mode bypasses permission prompts"），alwaysAsk 工具仍拦 |
| `auto` | **保留未实现**：一律 deny |

值得写的细节：
- **yolo 放行在 disallowedTools 硬禁用之前**——代码注释明确承认这一点（除了 alwaysAsk 工具）。
- **会话级"完全访问"**：权限弹窗里选完全访问时不是简单改 mode，而是先事务写一条回执（含队列中被授权的输入 id）再改内存 mode=yolo——崩溃后回执可恢复，不会出现"半个授权"。

### 1.2 规则数据结构
ZCode 没有 settings.json 式权限文件。三层规则：
1. **项目规则（持久）**：存 SQLite `local_settings` 表。JSON 形状（`contracts/src/interfaces/permission.port.ts`）：
```json
{
  "version": 1,
  "allow": [ { "toolName": "Bash", "ruleContent": "git status:*" },
             { "toolName": "Edit", "ruleContent": "/src/**" } ],
  "deny":  [ { "toolName": "Bash", "ruleContent": "rm -rf:*" } ],
  "ask":   [ { "toolName": "WebFetch", "ruleContent": "domain:example.com" } ],
  "mode":  "build"
}
```
2. **会话规则（内存）**：由弹窗选项 "Always allow in this session" 合成——`{toolName}` 无 content，**整工具授权**（因为脚本每次不同）。注释精辟："一个实例 = 一个 app = 一个会话，重启 / 冷恢复 / /new 都会造一个空的新实例"。
3. **进程配置**：`{ allowedTools, disallowedTools, autoApproveHighRisk }`。

**规则匹配语法**（`core/src/permission/service.ts` + `rule-matching.ts`）：
```ts
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
```
- `ruleContent` 以 `:*` 结尾 → **前缀规则**：subject 等于 prefix 或以 prefix+" " 开头。这就是 `Bash(git commit:*)` 风格。
- 含 `*` → 通配符正则。
- 否则 → 全字符串相等。
- 本质是 `PermissionRuleValue { toolName, ruleContent? }` 二元组；无 content 即"该工具任意调用"。
- **subject 提取**：输入是字符串则整个字符串；`WebFetch` 特殊处理为 `domain:<hostname>`；对象输入按 `command → url → file_path → path → pattern` 顺序取第一个字符串字段。

### 1.3 判定流程（PermissionService.checkPermission 的顺序）
```
 1. PlanMode 转移特判:  EnterPlanMode → allow
                        ExitPlanMode 且不在 plan → deny(mode.plan.exitOnly)
 2. capability.requiresUserInteraction?
      ├─ 在 disallowedTools → deny
      └─ 否则 → ask(tool.userInteraction)          ← AskUserQuestion/ExitPlanMode 走这里
 3. capability.alwaysAsk? →
      auto → deny | disallowedTools → deny | 项目 deny → deny
      会话规则 allow → allow(rule.session.allow)    ← "Always allow in this session" 只在这里生效
      否则 → ask(tool.alwaysAsk)                    ← ask 压过 yolo/plan 直通，但压不过硬阻断
 4. mode==yolo 且非 plan → allow(mode.yolo)
 5. mode==auto → deny(mode.auto.unimplemented)
 6. disallowedTools → deny
 7. 项目 deny 规则命中 → deny
 8. 项目 ask 规则命中 → ask
 9. planEnabled → checkPlanMode:
      readOnly&&!destructive → allow(mode.plan.readOnly)
      MCP 工具 &&!destructive → allow
      显式声明 allowedInPlanMode+session+无副作用 → allow
      其余 → deny（不给弹窗机会）
10. 项目 allow 规则命中 → allow
11. WebFetch 预批 URL → allow
12. config.allowedTools → allow
13. mode==edit → checkEditMode: (edit && workspace) → allow, 否则落 build
14. checkBuildMode:
      readOnly&&!destructive&&!needsApproval → allow(mode.build.readOnly)
      riskLevel=critical → ask | =high 且未 autoApproveHighRisk → ask
      session+low+非破坏 → allow(mode.build.sessionState)      ← TodoWrite/CronList 走这里
      needsApproval||destructive||sideEffectScope≠none → ask
      否则 → allow(mode.build.lowRisk)
```
工具能力来自 `ToolEntry.permission`（每个工具声明 permission 名、riskLevel、sideEffectScope、needsApproval、alwaysAsk）。

### 1.4 Bash 的专项规则评估（书里最值得展开的一段）
普通工具走 `some()`（任一规则命中即放行），但 Bash 走定制 evaluator：
```ts
// bash-command-rule-evaluator.ts（摘录）
export function evaluateBashRules(input: BashRuleEvaluationInput): boolean {
  if (input.rules.some((rule) => !rule.ruleContent)) return true;      // 工具级规则直接命中
  if (input.exactCommands.some((c) => c.length > 0) &&
      input.rules.some((r) => input.exactCommands.includes(r.ruleContent ?? ""))) {
    return true;                                                       // 整条命令原文精确匹配
  }
  if (!input.safe) return false;                                       // 复杂命令只认精确匹配
  const subjectGroups = input.behavior === "allow"
    ? input.requiredSubjectGroups      // allow：只看"非只读"的子命令
    : input.allSubjectGroups;          // deny/ask：任一子命令命中即算
  if (input.behavior !== "allow") {
    return subjectGroups.some((ss) => ss.some((s) => input.rules.some((r) => matchesInvocationRule(s, r.ruleContent))));
  }
  return subjectGroups.every((ss) => ss.some((s) => input.rules.some((r) => matchesInvocationRule(s, r.ruleContent))));
  //                    ^^^^^ allow 语义：复合命令的每一段都必须被规则覆盖，一段漏网就弹窗
}
```
配套机制：
- **"可为前缀"安全判定**：命令可解析、无重定向、无动态词、env 赋值静态。不满足则只允许精确整串规则。
- **稳定前缀解析**：剥 `env/sudo/nohup/command/time` 包装（最多 2 层）；`HIGH_RISK_ROOT_COMMANDS`（`bash sh zsh rm rmdir chmod chown dd mkfs mount ...`）**不生成前缀规则**（永不建议 `rm:*`）；最终建议规则形如 `pnpm run lint:*`。
- 建议规则数量上限 5 条，超限退回整条命令原文。

### 1.5 权限询问的完整交互链路
执行层（`core/tool/executor/permission-flow.ts`）：
1. `checkPermission` → allow 直接放行；deny 发 `PermissionDenied` 事件并生成权限错误 result 回模型；ask 继续。
2. 发 `PermissionRequested` 事件（UI 渲染确认窗）。
3. **broker 与 PermissionRequest hook 并发竞速**（`racePermissionResponders`）——注释记录了真实 bug：曾串行 await hook，外部审批桥同步阻塞期间确认窗已渲染但应答 deferred 未注册，用户每次点击都被幂等语义静默丢弃，"确认窗永久死亡"。修复：hook 链故障只令其退赛，不替用户拒绝。
4. hook 返回 modify（改写输入）→ **重新校验 schema 并重跑权限判定**，防止借 hook 改输入绕过权限。
5. broker 结果四种：allow（可带 permissionUpdates）、deny（带 reason 回模型）、escalate、modify（改写输入后执行）。permissionUpdates → SQLite；sessionPermissionUpdates → 内存。

弹窗选项合成（`bootstrap/src/permission-options.ts`）：
```ts
return [
  { kind: "allow_once",  name: "Allow once",  response: { decision: "allow" } },
  ...(optionsPolicy === "no-always-allow" ? [] :
      optionsPolicy === "session-always-allow"
        ? [{ kind: "allow_session", name: "Always allow in this session", ... }]
        : [{ kind: "allow_always", name: "Always allow in this project", response: { decision: "allow", permissionUpdates } }]),
  { kind: "deny", response: { decision: "deny", reason: PERMISSION_DENIED_BY_USER_CONTENT } },
];
```
- **v4 应答映射是 fail-closed 的**：未知 optionId、无 optionId 一律 deny——"权限语义下宁可拒绝也不放行未知应答"。
- 拒绝文案直接命令模型停下："The user doesn't want to proceed... STOP what you are doing and wait for the user to tell you how to proceed." 用户附言时追加 "To tell you how to proceed, the user said:..."。
- 子 agent 的权限请求经代理到父 broker，带 origin 标注。

## 二、沙箱

**结论：ZCode CLI 当前没有任何 OS 级沙箱。** 全仓 grep `seatbelt|sandbox-exec|restricted token|Firejail|bubblewrap` 零命中。命令通过 `node:child_process.spawn` 直接起 shell。

但沙箱的"化石层"非常清晰：
1. **合同占位**：`contracts/src/interfaces/execution.port.ts` 仍定义 `ExecutionSandboxPolicy { enabled, profile?, dangerouslyDisableSandbox? }`，还有 `ExecutionFailureType: "sandbox_violation"`。
2. **Bash 工具仍传参**：`createExecutionRequest` 构造 `sandbox: { enabled: !input.dangerouslyDisableSandbox }`；模型可见 schema 仍有 `dangerouslyDisableSandbox` 参数。
3. **执行端完全不读**：`adapters/src/exec/` 没有任何 `request.sandbox` 消费；唯一残留是注释——"计时器提前到准备阶段是 protected-resource sandbox 时代的行为……sandbox 撤除后准备阶段只剩 shell snapshot"。

**真实的安全边界是"权限规则 + 语义分析 + 零散护栏"：**
| 机制 | 位置 | 作用 |
|---|---|---|
| Bash 命令解析 | `bash-command-parser.ts` | 复合命令、重定向、注入风险解析；不可解析 → 只允许精确规则 |
| 只读语义判定 | `bash-readonly-policy*.ts`（约 20 个文件） | plan 模式下 Bash 是否放行靠逐子命令白名单 |
| 路径策略 | `core/src/tool/path-policy.ts` | **不做工作区硬阻断**（见下方摘录） |
| memory 文件特判 | `tool/executor/memory-file-permission.ts` | memory root 下 .md 的 Write/Edit 免确认，但必须通过包含性检查 |
| WebFetch 出口防护 | `webfetch-egress-guard.ts` + 预批 URL 表 | 网络侧约束 |
| workspace hook 信任 | workspace-hook-trust-* | 项目 hook 首次运行需信任确认 |

```ts
// core/src/tool/path-policy.ts —— "写保护"的真相
const resolvedPath = isAbsolute(requestedPath)
  ? normalize(requestedPath)
  : resolve(workingDirectory, requestedPath);
// Current release intentionally does not hard-block paths outside workspaceRoot.
// Cause: subagents may need to inspect user-requested sibling repos or external files
// before the filesystem permission adapter grows explicit ask/deny rules for them.
return resolvedPath;
```

## 三、Plan Mode

### 3.1 进入/退出与策略
- 两个工具：`EnterPlanMode` / `ExitPlanMode`（`core/tool/handlers/plan-mode.ts`）。Enter 永远 allow 无弹窗；Exit 只在 plan 模式有效，否则 deny。
- **plan 是 execution-state 上的 flag 而非 mode**：`enterPlanMode` 只 `applyRuntimeExecutionState({ planEnabled: true })`，`mode` 保持 build/edit——退出时能回到原模式。PermissionService 里 plan 判定看 `context.planEnabled ?? mode === "plan"`。
- **限制哪些工具**：checkPlanMode（1.3 第 9 步）——readOnly 且非 destructive 放行；MCP 工具非破坏放行；其余一律 deny（不给弹窗机会）。Bash 的放行完全依赖只读语义分析。
- **提示词强化**：每 5 个人类 turn 注入 PLAN_MODE_FULL_REMINDER（含 4 阶段工作流：Explore 子代理并行探码 → 设计 → 复审+AskUserQuestion → 必须以 ExitPlanMode 结尾）；退出后注入 PLAN_MODE_EXIT_REMINDER。规则先于提示词：deny 硬拦 + reminder 软引导双保险。

### 3.2 plan 文件与批准
- `ExitPlanMode` 输入 `{ plan, allowedPrompts? }`，plan 上限 20,000 字符。
- 批准**前**先把 plan 原子写入磁盘：`<workspaceRoot>/.zcode/plans/plan-<sessionId>.md`。
- ExitPlanMode 声明 `requiresUserInteraction: true` → ask → 协议 broker 转成单题问卷。用户：
  - Approve → broker allow → exitPlanMode() → 模型收到 "User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n## Approved Plan:..."；
  - 输入 freeText → **deny 但 reason 带 `reasonSource: "plan_approval_feedback"`**——deny+reason 只有带专用 source 才允许被升级为真实 user message，实现"反馈式拒绝"。
- 之后新会话若存在 plan 文件，以 system-reminder `plan_file_reference` 注回。

## 四、Todo

- 工具：`TodoRead` / `TodoWrite`（`core/tool/handlers/todo.ts`）。数据结构：
```ts
export const TodoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["high", "medium", "low"]),
});
```
- **全量替换语义**：TodoWrite 每次发完整列表，返回 `{ oldTodos, todos, summary: { total, pending, inProgress, completed } }`。旧版"最多一个 in_progress"约束被整段注释掉（多 subagent 并行需要多个 in_progress）。
- 权限：TodoRead `sideEffectScope:"none"`；TodoWrite `sideEffectScope:"session"`、`needsApproval:false` → build 模式命中 `mode.build.sessionState` 直通，plan 模式命中 readOnly 直通。
- **存储**：SQLite `todo` 表（session_id, content, status, priority, position, time_created/updated），在事务里 delete-all + 重插。
- **上下文注入**：TodoWrite 的结果"rendered to the user as your working plan"；**todo reminder**：距上次 TodoWrite ≥10 个 assistant turn 且距上次 reminder ≥10 turn → 注入提醒（含现有清单）。

## 五、Goal（会话目标，内部遗留名 "Target"）

Goal **不是模型可调用的写入工具**（契约里有 GoalRead），由用户通过 `/goal` 命令设置。

数据结构（`contracts/src/tools/target.ts`）：
```ts
export interface SessionGoal {
  sessionID: SessionId;
  targetID: string;                    // 兼容旧名
  objective: string;                   // ≤ 4000 字符
  status: "active" | "paused" | "budget_limited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  time: { created: number; updated: number };
}
```

**机制核心 = 空闲自动续跑 + 独立完成性校验器**（`core/src/runtime/methods/target.ts`）：
1. turn 结束后 `continueActiveTargetIfIdle` 入队 target-continuation 命令；候选条件：无活跃 turn、session 已持久化、**非 plan 模式**、goal status=active。
2. 续跑前先跑**独立 verifier LLM 调用**：只允许返回 `{"passed": boolean, "reason": string, "nextAction": string}`。
3. 判定语义防呆：verifier 输出坏 JSON → **fail-open**（"避免已经交付的 goal 被格式错误卡住"）；verifier 失败但无 nextAction → 不续跑（防把内部错误变成无限迭代）；passed → 停；failed with nextAction → 用 continuation prompt（包成 `<system-reminder>`）自动开新一轮。
4. verifier 提示词内置"完成审计清单"：prompt-to-artifact checklist、不认代理信号（测试绿≠完成）、**"Do not mark the goal complete yourself"**；对纯寒暄目标先分类为 non-task 直接 pass，防无限续跑。
5. **防提示注入**：objective 全程包在 `<untrusted_objective>` 标签内并做 HTML 转义。
6. **记账**：SQLite 累计 tokensUsed/timeUsedSeconds，超预算 → status=budget_limited；每步发 TargetChanged 事件。
7. **状态机**：用户 Stop → pauseActiveTargetForCancellation（status=paused）；冷恢复**不**自动把 paused 改回 active（"显式 /goal resume 才能重新激活"）。

## 六、定时任务 / Loop（Cron Automations + OffPeak）

### 6.1 工具与数据
四个工具：`CronCreate / CronList / CronUpdate / CronDelete`，全部委托 `automationPort`。数据模型：
```json
{
  "automationId": "…",
  "title": "每20分钟喝水提醒",
  "cronExpr": "*/20 * * * *",
  "prompt": "提醒用户喝水",
  "enabled": true,
  "recurring": true,
  "maxRuns": null,
  "scheduleRule": { "unit": "minute", "interval": 20 }
}
```

### 6.2 三种调度表达（contract 层 refine 强约束）
1. **cron**：标准 5 字段、用户本地时区、明确"Do not convert to UTC"。
2. **delayMinutes**（相对一次性，1..525600）：与 cron **互斥**；强制 `recurring=false`。设计动机注释极佳：模型对"现在"的时刻常是陈旧的，自算一次性时刻一旦刚过会被 host 静默滚到下一年——"8分钟后"必须用 delayMinutes 让 host 拿真实时钟锚定。
3. **intervalUnit + interval "carrier"**（每 N 单位，1..200）：绕开 cron 字段上限——"every 40 days at 09:00" → `intervalUnit:"daily", interval:40, cron:"0 9 * * *"`。真实间隔由 host 的 scheduleRule 承载，cronExpr 只是合法兼容展示。

### 6.3 调度器与持久化在哪？
**不在 CLI 内。** `bootstrap/src/zcode-protocol/automation-port.ts` 是纯协议代理：转发给**宿主**（桌面端/host），宿主负责 cron 解析、nextRunAt 计算、触发派发与持久化。CLI 侧能确认的语义：automations 绑定 workspace、会话内创建的任务**复用当前 session**、绑定创建时的 modelSelection 与 mode。

### 6.4 防递归三重防御（最好的一节素材）
定时任务轮里禁止再创建/改删定时任务：
1. **provider 可见性**：automation turn 的 tool denylist 隐藏 CronCreate/CronUpdate/CronDelete；
2. **handler 终审**：`assertNotAutomationTurn` 直接 PermissionDenied，**且刻意不调用端口**（"provider tool denylist 只是可见性约束，旧入口或异常 provider 仍可能直接提交"）；
3. **端口入口兜底**：当前 turn 由 automationId 派发 → 拒绝（"Cannot create a scheduled task while running a scheduled task."）；当前会话已绑定某 automation → 查询失败 **fail-closed** → 拒绝。

### 6.5 权限与周边
- CronCreate/Update/Delete `needsApproval:true`、`riskLevel:"medium"` → build 模式必弹窗；CronList 只读直通。
- 创建额度错误映射为稳定领域错误 `AutomationCreateLimitError`（防模型把错误文案里的"建议删除"当成可执行恢复步骤）。
- **OffPeak 兄弟机制**：闲时任务 `OffPeakCreate/OffPeakList`；**cron automation 轮明确放行 OffPeakCreate**（定时派生闲时任务是合法场景）——两个常量刻意不合并，注释警告"勿照抄 cron 的防御方向"。

## 七、AskUserQuestion（结构化提问）

- 契约：1-4 题；每题 `question/header(≤12字符)/options(2-4 个 label+description+preview?)/multiSelect`；preview 只支持单选；"Other" 自由文本由 UI 自动提供；推荐选项放第一个加 "(Recommended)"。
- **机制上它是权限系统的特例**：工具声明 `requiresUserInteraction: true` → 判定必 ask → 协议 broker 按 toolName 分流到 `requestUserInput`。
- **答案注入方式是决策 `modify`**（关键设计）：
```ts
// bootstrap/src/zcode-protocol/interaction-broker.ts（摘录）
function userInputResponseToBrokerResult(request, response): PermissionBrokerResult {
  if (response.action !== "accept") {
    return { decision: "deny", reason: /* cancelled */ };
  }
  const input = isRecord(request.input) ? request.input : {};
  const content = normalizeAskUserQuestionResponseContent(input, response.content);
  return {
    decision: "modify",                       // 不是 allow，是"改写输入后放行"
    modifiedInput: { ...input, ...content },  // content = { answers: {问题文本: 答案} }
  };
}
```
- handler 用 schema 校验 **answers 必须已在输入里**，否则报 "AskUserQuestion requires user answers before execution"——handler 本体只是把答案格式化回模型。

## 八、核心代码片段索引

1. 判定主序列：`core/src/permission/service.ts:97-231`
2. 前缀规则匹配：`core/src/permission/service.ts:307-320` + `rule-matching.ts:1-7`
3. Bash allow 语义（every vs some）：`core/src/tool/handlers/bash-command-rule-evaluator.ts:13-38`
4. ask 竞速（确认窗死亡 bug 修复）：`core/src/tool/executor/permission-flow.ts:178-236`
5. 路径不硬阻断的坦白：`core/src/tool/path-policy.ts:36-39`
6. AskUserQuestion 的 modify 决策：`bootstrap/src/zcode-protocol/interaction-broker.ts:370-397`

## 九、教学简化建议

1. **先立四层模型再讲细节**：`ToolEntry.permission`（工具自报能力）→ `PermissionService`（纯函数判定，无 IO）→ `PermissionBrokerPort`（异步问人端口）→ 交互实现（协议弹窗）。"判定/询问分离"是全书最值得教的结构——PermissionService 不依赖任何 IO，可以整章用单元测试讲优先级。
2. **规则语法收敛为一个心智模型**：`工具 + 内容模式`，内容模式只有三态（精确 / `prefix:*` 前缀 / `*` 通配）。Bash 的 "allow 要 every、deny/ask 只要 some" 必须单独一小节——这是复合命令安全的通用难题。
3. **沙箱一章要讲"负空间"**：诚实写"合同里有 ExecutionSandboxPolicy、工具参数里有 dangerouslyDisableSandbox、但执行端不消费"——这是真实项目里"沙箱先拆、接口留形"的活化石；再以 path-policy 注释和 memory-file 免确认讲"软边界"权衡。
4. **Plan Mode 讲"flag 而非 mode"**：planEnabled 与 mode 解耦（退出即回原模式）+ 规则先于提示词（deny 硬拦 + reminder 软引导双保险）+ plan 文件作为"跨会话记忆"三件套。
5. **Todo 当"最小状态机"讲**：全量替换 + 单表存储 + 10-turn reminder 惰性注回。
6. **Goal 讲"验证者模式"**：主线是"续跑 prompt 与完成判定分离、独立 verifier、fail-open/fail-closed 的选择理由、objective 当不可信输入包裹"。这才是 autonomous loop 的正确教法。
7. **定时任务讲"递归防御"**：可见性 → handler 终审 → 端口归属检查三层 + fail-closed 查询 + delayMinutes 让 host 掌握时钟（"不要让模型知道现在几点"是可以写成格言的设计原则）。
8. **交互链路讲 race**：确认窗/hook/abort 三方竞速 + 未知应答 fail-closed + deny 文案直接指挥模型停下——把"权限弹窗"从 UI 细节升华为"人类在 agent 回路中的协议设计"。
