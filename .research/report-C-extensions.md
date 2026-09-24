# 调研报告 C：MCP 与扩展机制（供第 2.2、4.1、4.2、4.3、6.4 章使用）

来源：ZCode CLI 源码调研。

## 〇、总体

六边形架构（端口-适配器）：`packages/contracts` 定义契约，`packages/core` 纯运行时（不碰 Node API），`packages/adapters` Node 侧实现，`packages/bootstrap` 装配，`packages/cli` 入口。扩展机制都遵循"contracts 定义契约 → adapters 发现/加载 → core 运行时消费"。

## 一、MCP

### 1.1 分层
| 层 | 文件 | 职责 |
|---|---|---|
| 契约 | `contracts/src/interfaces/mcp.port.ts` | `McpPort` 接口、`McpServerConfig` 三种传输配置 |
| 适配器 | `adapters/src/mcp/index.ts`（1950 行） | 真正的 MCP 客户端，基于 `@modelcontextprotocol/client`（SDK 2.0.0） |
| 传输 | `adapters/src/mcp/stdio-transport.ts` | stdio 进程树托管版 transport |
| 连接池 | `adapters/src/mcp/pool.ts` | 按 session/workspace 隔离的连接复用 |
| 工具桥 | `core/src/mcp/index.ts` | 把 MCP 工具描述符投影为内部 ToolRegistry 条目 |
| 命名 | `core/src/mcp/name.ts` | `mcp__server__tool` 命名规则 |

**关键结论：ZCode 只消费 MCP 的 tools 能力**（tools/list → tools/call）；resources/prompts/sampling 均未接入。

### 1.2 配置格式
`McpServerConfig` 判别联合：
```ts
export type McpServerTransportType = "stdio" | "http" | "sse";
export interface McpServerConfigBase {
  enabled?: boolean;
  isolation?: "session" | "workspace";
  timeoutMs?: number;
}
export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string>;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http"; url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig;
}
```

**配置来源（四级，后者覆盖前者）**：
```ts
const configuredMcpServers = {
  ...pluginMcpServers,                    // 1. 插件（plugin: 前缀，天然不冲突）
  ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers), // 2. 用户/项目配置
  ...builtInMcpServers,                   // 3. 宿主内建（node_repl，防劫持）
};
```
- 用户级：`~/.zcode/cli/config.json` 的 `mcp.servers`。
- 项目级：`<repo>/.zcode/config.json`。项目级 MCP 默认受信并自动连接。
- 插件级：插件根目录 `.mcp.json`；server 名命名空间化为 `plugin:<pluginName>:<原名>`。

真实插件配置示例（stdio + 变量插值）：
```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "cwd": "${CLAUDE_PROJECT_DIR}",
      "env": { "IOS_SIM_DEFAULT_DEVICE": "${user_config.default_device}" }
    }
  }
}
```
变量插值规则：`${ZCODE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT}`（插件根目录）、`${ZCODE_PROJECT_DIR}`、`${user_config.<key>}`。安全设计：**任意环境变量只能在"敏感 sink"（headers、env）里展开，绝不允许展开进 command/args/url**。

### 1.3 传输与生命周期
- **stdio**：子类 `ProcessTreeStdioClientTransport`——Windows 上把子进程挂进 Job Object，dispose 时回收**整棵进程树**（只杀直接子进程会留孤儿）。
- **HTTP**：`StreamableHTTPClientTransport`；OAuth 流程。
- **探活**：`pingServer`（5 秒超时）——"ping 是把 transport 存活性显式化的唯一手段"。
- **自愈**：调用前若 record 已 disconnected 则先重连；调用中抛 "Not connected" 时重连重试一次。
- **状态机**：`connecting | connected | disabled | disconnected | failed | untrusted`。

### 1.4 工具注册：`mcp__server__tool` 命名空间
```ts
export function toMcpToolName(descriptor): string {
  return `mcp__${toModelVisibleMcpNamePart(descriptor.serverName)}__${toModelVisibleMcpNamePart(descriptor.toolName)}`;
}
export function toModelVisibleMcpNamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_") || "unknown";
}
```
注册桥的安全/预算语义：
- **风险分级**：`readOnlyHint` → low，`destructiveHint` → high，否则 medium。
- **needsApproval: true**（所有 MCP 工具默认要审批）。
- **超时**：`descriptor.timeoutMs ?? 30_000`，不允许调用方覆盖。
- **结果预算**：普通 MCP 100KB inline/50KB 模型；大 base64 图片存为 artifact。
- 注释反复强调：**server/tool 名可被第三方仿冒，名称不构成信任**（官方 CUA 用 authority 凭据验明）。

运行时接线：session 创建时 `startMcpStartup` → `initializeMcp` 拿 snapshot 调 `registerMcpTools`，注册后 `invalidateToolCache()`。整个 MCP 初始化失败只 warn 不致命。

## 二、Hooks

### 2.1 事件完整清单（恰好 7 个）
| 事件 | 触发时机 | matcher 匹配值 | 专属输入字段 | 专属输出能力 |
|---|---|---|---|---|
| `SessionStart` | 会话启动/恢复/清空/压缩（source: startup/resume/clear/compact） | source | `model, source` | `additionalContext` |
| `UserPromptSubmit` | 用户提交 prompt 后、发给模型前 | prompt 全文 | `prompt` | `additionalContext` |
| `PreToolUse` | 工具执行前 | 工具名 | `toolName/toolInput/riskLevel/sideEffectScope` | `permissionDecision: allow/ask/deny` + reason、`updatedInput`、`additionalContext` |
| `PermissionRequest` | 权限弹窗出现时（可代替用户应答） | 工具名 | + `requestId/reason` | `decision: {behavior: allow/deny}` |
| `PostToolUse` | 工具成功返回后 | 工具名 | + `toolResponse/toolResultPreview` | `additionalContext` |
| `PostToolUseFailure` | 工具失败后 | 工具名 | `error{message,type}` | `additionalContext` |
| `Stop` | 一轮回答结束时 | response 预览 | `responseText/stopHookActive/toolCallCount` | `additionalContext`；`decision: "block"` 可逼模型继续 |

### 2.2 配置格式
```jsonc
// ~/.zcode/cli/config.json 或 <repo>/.zcode/config.json 的 hooks 键
{
  "hooks": {
    "enabled": true,            // 配置文件 hook 默认 false，必须显式开启
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        { "matcher": "Bash|PowerShell",
          "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] }
      ]
    }
  }
}
```
两种 hook 类型：`type: "command"`（shell 字符串，`timeout` 秒 / `timeoutMs` 毫秒优先）；`type: "process"`（可执行文件 + args[]，argv 直接 spawn，最可移植）。

### 2.3 matcher 语法
```ts
export function matchesHookMatcher(matchValue, matcher): boolean {
  if (!matcher || matcher === "*") return true;
  if (!matchValue) return false;
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) return matcher.split("|").includes(matchValue); // 纯字母|语法当枚举
  try { return new RegExp(matcher).test(matchValue); } catch { return false; }           // 否则当正则
}
```
大小写敏感；非法正则**静默永不匹配**；省略 matcher 匹配一切。工具事件有别名归一（Task↔Agent）。

### 2.4 执行语义：stdin / stdout / 退出码
**输入**：整个 `HookInput` 序列化为 JSON 写入 **stdin**（末尾换行）。主契约 camelCase（`hookEventName`、`sessionId`、`toolInput`…），同时补 snake_case 兼容别名（`hook_event_name`、`tool_name`、`tool_input`…）以兼容 Claude Code 风格脚本。环境变量注入 `ZCODE_PROJECT_DIR`/`ZCODE_SESSION_ID`（+ `CLAUDE_*` 兼容名）。

**输出/退出码**：
- **exit 0**：stdout 若以 `{` 开头则 JSON.parse 并按 schema 严格校验；非 JSON stdout 当诊断文本忽略。`HookJSONOutput` 键：`additionalContext`、`continue`、`decision: "approve"|"block"`、`reason`、`systemMessage`、`hookSpecificOutput`（按事件判别）。
- **exit 2**：**阻断语义**。stderr 作为 blockReason——PreToolUse → `permissionDecision: "deny"`；Stop → `decision: "block"`；其余 → `continue: false`。
- **其他退出码/超时**：记录 Failed/TimedOut，**不阻断主流程**。

**运行器**：按事件过滤 + matcher 匹配 → 顺序执行（非并行）；发 `HookRunStarted/Completed/Failed/Blocked` session 事件（stdout/stderr 4000 字符预览）。

### 2.5 workspace hook 信任模型
- **问题**：`<repo>/.zcode/config.json` 里的 hooks 是克隆仓库就带进来的代码，直接执行等于"clone 即 RCE"。
- **方案**：每条 hook 声明计算 **sha256 的 `hookDeclarationDigest`**，所有条目合成 **`bundleDigest`**。
- **信任状态机**：`not_applicable / pending_trust / trusted_persistent / blocked_untrusted / blocked_policy / revoked / stale_digest`。声明 digest 变化 → `stale_digest`（重新走审批）。
- **关键安全细节**：**授权决定绝不缓存**——每个 hook 实际 dispatch 前重新评估 admission，前序 hook 运行期间发生的 revoke 立即生效；admission gate 自身抛异常时 **fail closed**。

## 三、Skills

### 3.1 SKILL.md 格式
frontmatter 扁平 YAML 标量：
- `name`：必需；
- `description`：必需，超长（>1024 字符）报错；
- `when_to_use`：可选，追加在 description 后进模型可见清单。

真实样例（`packages/bundled-skills/skills/dynamic-workflows/SKILL.md`）：
```yaml
---
name: dynamic-workflows
description: "Use when writing, debugging, or resubmitting a dynamic-workflow script..."
when_to_use: "Only for CreateWorkflow scripts. A single delegation ... belongs to the Agent tool instead."
---
```

### 3.2 发现：目录、优先级、信任边界
`resolveDefaultSkillRoots` 优先级：
1. 显式配置 roots（`skills.roots`）；
2. 用户级：`~/.zcode/skills` → `~/.agents/skills`（合并）；
3. 项目级：从工作目录**向上每一层**直到 git worktree 根，每层的 `.zcode/skills`、`.agents/skills`；
4. 插件 roots（priority 从 1000 起；`qualifiedName = "pluginName:skillName"`）。

扫描规则：根目录自身有 SKILL.md 则根自身是一个技能，再扫一层子目录。**插件 scope 一律不跟随符号链接**（注释：symlink 可指向 `~/.aws/credentials`，于是收敛为"拒绝链接即拒绝逃逸"）；用户级根保持跟随。禁用机制：config 的 `skillOverrides`（键为 SKILL.md 绝对路径）。

### 3.3 注入与渐进披露
两层设计：
1. **元数据层**：全部技能的 `名称: 描述(≤250字) (file: 路径)` 清单注入 meta_user 上下文段，预算 20000 字符，超预算降级为仅名称+路径。
2. **正文层**：模型按需调 `Skill` 工具加载正文（上限 100KB），包上 `<skill_content name="...">...</skill_content>` 并声明 base directory；`${ZCODE_SKILL_DIR}` **只在此时**展开。

**技能门**（`core/src/agent/loaded-skills.ts`）：`sessionHasLoadedSkill` 扫描 provider 可见历史判断"本会话是否成功加载过某技能"——刻意取自历史而非另立 Set：compaction 把 Skill 调用挤出去，门就重新关上。消费方：`CreateWorkflow` 等工作流工具在未加载 `dynamic-workflows` 技能前拒绝执行。

## 四、Plugins

### 4.1 清单格式 plugin.json
发现路径 `.zcode-plugin/plugin.json`（兼容 `.claude-plugin/`）。必需字段仅 `name`（`/^[a-z0-9][a-z0-9._-]{0,127}$/`）。完整字段：
```jsonc
{
  "name": "zcode-guide",              // 必需
  "version": "0.2.0",
  "description": "...", "author": {"name": "Z.ai"},
  "commands": "commands",             // 目录名 | 路径数组 | 内联对象
  "skills": "skills",
  "hooks": "hooks/hooks.json",        // 路径 | 内联 | 数组
  "mcpServers": {...},                // 内联或 ".mcp.json" 路径
  "agents": "agents",
  "userConfig": {                     // 用户可配置项，供 ${user_config.*} 插值
    "sdk_path": { "type": "directory", "required": true, "description": "..." }
  }
}
```
插件稳定 ID = `"<name>@<marketplace>"`。

### 4.2 发现与加载
1. **候选收集**：config.dirs（inline）→ 官方 bundled roots → 官方缓存 → 市场安装记录。
2. **去重/抑制**：`<name>@<marketplace>` 重复 → warning；官方插件"卸载"是在 user config 写 `suppressedBuiltins`。
3. **启用判定**：`enabledPlugins[id] ?? defaultEnabled`。
4. **组件解析**：产出 `{commandRoots, hooks, mcpServers, skillRoots}`，bootstrap 分别并入各子系统。
5. **安全细节**：所有组件路径 `resolveInside(pluginRoot, p)` 防逃逸；`ZCODE_PLUGIN_ID` 由 resolver 权威写入 env，第三方不能伪造。

### 4.3 Marketplace 结构
- 三份持久文件：`known_marketplaces.json`、`installed_plugins.json`、每市场的 `marketplace.json`。
- **marketplace.json**：`{ name, plugins: [{ name, source, version, ... }] }`；`source` 支持 url（zip）/ github / git / npm / file / directory。
- 官方市场 `zcode-plugins-official`：bootstrap 启动时把随应用分发的官方插件 **seed** 进本地缓存（sha256 清单 + 原子落盘）。
- 安装采用**原子目录激活**（临时目录构建 → rename 切换 → 崩溃恢复）。

### 4.4 插件实例
- **browser-use-plugin**：manifest 极简——`{ "name": "browser-use", "version": "0.5.1", "skills": "skills" }`，内容只有两个技能。展示了"技能插件"的形态。
- 更完整的实例：ios-simulator（stdio MCP + user_config 插值 + hooks/hooks.json）、image-search（http + 官方鉴权）、zcode-guide（commands+skills 内容型，5 个诊断技能——"插件 = 命令+技能+提示词工程"的示范）。

## 五、斜杠命令（Custom Commands）

### 5.1 两类命令
1. **内置命令**：`cli/src/command-center/slash-commands.ts` 硬编码（help、compact、model、mcp、mode、rewind、resume/new/clear、init、goal、login…）。
2. **自定义命令**：markdown 文件，未命中内置名的 `/xxx` 落到这里。

### 5.2 markdown 命令文件格式
发现目录与 skills 完全同构：显式 roots → `~/.zcode/commands` → `~/.agents/commands` → 项目各层 `.zcode/commands`、`.agents/commands` → 插件 roots。递归扫描（深度 12），**子目录拼进命令名**：`review/code.md` → `/review:code`。

frontmatter 白名单：
```markdown
---
description: Review the current diff          # 必需（或从正文首段提取）
argument-hint: "[pr-number] [--verbose]"      # UI 补全提示
allowed-tools: Bash(git *), Read              # 免审批工具
model: glm-4.7
disable-noninteractive: true                  # headless 下禁用
skills: code-review, security                 # 声明依赖的技能
---
正文即 prompt 模板…
```

### 5.3 展开
```text
$ARGUMENTS  → 用户参数整串替换
$1 $2 ...   → 位置参数（引号感知的 split）
```
- 有参数但模板里没有占位符 → 自动追加 `\n\nUser arguments:\n<args>`；
- `!`...`` 与 ``` ```! ``` shell 展开（Claude Code 动态语法）**明确不支持**，检测到直接抛错；
- 最终 prompt 包装：`Run custom command /<name>.` + `Command source: <scope>.` + （若声明 skills）`Before following the command body, call the Skill tool for ...` + 模板正文——作为普通用户消息提交。

### 5.4 与 Skill 的关系（可单讲一节）
1. 命令 frontmatter 的 `skills:` 字段在展开时**强制要求**模型先调 Skill 工具加载这些技能再执行正文；
2. `/skill <name> [task]` 是手动加载技能的内置命令；
3. **命令（markdown→prompt 注入）与技能（markdown→按需加载的工具）共享同一套发现目录与优先级规则，差异在注入时机（立即展开 vs 模型按需调用）与参数处理（命令有 $ARGUMENTS，技能靠模型填 args）**。

## 六、贯穿性设计主题

1. **Claude Code 兼容层无处不在**：`CLAUDE_PLUGIN_ROOT`、`.claude-plugin/`、snake_case hook stdin 字段、`.agents/skills|commands` 目录——全部作为"兼容别名"与原生并存，且原生优先。
2. **信任边界显式化**：官方 MCP 的"名称不可信、authority 凭据才可信"、插件 symlink 不跟随、workspace hook 的 digest+审批、`user_config.sensitive` 只能进敏感 sink。
3. **诊断即产品**：`PluginDiagnosticCode`（25 个枚举）、`WorkspaceHookReasonCode`（20 个），把"静默失败"逐一消灭。

## 七、教学简化建议

1. **主线只讲一条扩展轴**："markdown 进 prompt"（skills/commands）与"JSON 进进程"（hooks/MCP/plugins）两大类。顺序：skills（最简单）→ commands（= skills 的参数化模板）→ hooks（7 事件 + stdin/stdout/退出码协议）→ plugins（把前三种打包 + MCP）→ MCP（最重，独立一章）。
2. **MCP 一章砍掉**：官方鉴权、CUA 投影、OAuth 恢复、连接池、process-tree transport。保留：三种传输的 config JSON、命名空间规则、riskLevel/needsApproval/resultBudget 表、失败状态机。用一个 20 行的"最小 stdio MCP server"示例贯穿。
3. **Hooks 章用"一个 JSON 协议"组织**：输入 = stdin JSON（给 2 个真实事件样例），输出 = exit code 语义表（0/2/其他）+ 7 事件×触发时机表。matcher 只需讲三种：省略/`*`、`"A|B"`、正则。workspace 信任模型压缩成一页"为什么要 digest + 审批"的安全专栏。
4. **Skills 讲清渐进披露**：清单先行（2 万字符预算）、正文按需 100KB 加载、`${ZCODE_SKILL_DIR}` 延迟展开；再给"description 里写 trigger 条件"的实操建议。
5. **Plugins 章用"最小可跑"清单**：plugin.json 只需 name；加 skills/ 即成内容插件；再逐步加 mcpServers。marketplace 只讲"marketplace.json 列 source，装进 cache 目录，enabledPlugins 存开关"三层。
6. **警示读者不要照抄的细节**：hook 的 timeout（秒）与 timeoutMs（毫秒）双轨；async 字段无运行时效果——"真实项目的毛边"适合做"工程现实 vs 教学模型"讨论框。
