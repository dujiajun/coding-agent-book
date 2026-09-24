# 调研报告 E：SubAgent、后台任务与动态工作流（供第 2.5、5.6、5.7 章使用）

来源：ZCode CLI 源码调研。路径相对 `apps/zcode-cli/`。

## 一、SubAgent：完整生命周期

### 1.1 总体架构：子 agent 是一个完整的 AgentRuntime 实例
子 agent **不是**一个简化循环，而是复用与主 agent 完全相同的 `AgentRuntime` 类（`packages/core/src/runtime/agent-runtime.ts`），拥有：
- **独立的 child session**（`subagent_<agentId>`，独立持久化、可 resume）
- **独立上下文**（`SubagentContextBuilder` 自行组装 system prompt，不继承父会话的 Project Context，只按 `injectAgentsMd` 决定是否继承 AGENTS.md）
- **独立的 executeTurn 循环**（子 agent 内部跑完整 turn loop）
- **但工具面、权限、MCP、Skill 全部从父 runtime 裁剪/借用**

装配代码在 `packages/core/src/runtime/methods/subagent.ts` 的 `runExploreAgent`：在父 AgentRuntime 内部 `new AgentRuntime(sessionId, {childConfig}, {childDeps})`，然后 `childRuntime.executeTurn(request.prompt, ...)`。

### 1.2 入口：Agent 工具
- 工具定义：`packages/core/src/tool/handlers/agent.ts`。工具名 `Agent`（`Task` 为兼容别名）。参数：`description`（3-5 词任务描述）、`prompt`（完整自包含任务书）、`subagent_type`（缺省 `general-purpose`）、`run_in_background`。
- 工具描述动态生成：内嵌全部可用 agent profile 列表，并声明「agent 的最终消息作为 tool result 返回给你，不会直接展示给用户」「同一消息里发多个 Agent 调用可并行」。
- handler 直接调 `context.subagentPort.launch(...)`。

### 1.3 SubagentPort：前台 run / 后台 start
`packages/core/src/subagent/runner.ts`（约 2100 行）：
| 方法 | 行为 |
|---|---|
| `launch(request)` | `run_in_background === true` 或 profile `background: true` → `start()`；否则 `run()` |
| `run(request)` | **前台**：注册任务 → 写 metadata → 创建 child runtime → `Promise.race`（完成 vs 转后台请求 vs 自动转后台定时器）→ 返回完成输出或转后台输出 |
| `start(request)` | **后台**：注册 `isBackgrounded: true` 任务，不 await，立即返回 `async_launched` |
| `sendMessage` | 向运行中 agent 转向（steer），或**复活已终态的 agent** 在后台续跑 |

生命周期（前台 run）：
1. 解析 profile：按 `agentType` 精确 → 归一化近似匹配 → 歧义报错（列出全部可用类型，模型可自纠）。
2. 创建 lifecycle：`agentId = agent_<uuid>`，`childSessionId = subagent_<agentId>`，输出目录 `<tmp>/zcode-agents/<parentSessionId>/<agentId>/`（metadata.json、output.txt、task.output）。
3. 注册任务 + 写 metadata.json。
4. AbortController 链：父 signal 的 abort 传播给子任务；`detachParent()` 用于转后台时切断联动。
5. 活动看门狗：子 runtime 每个事件都 `reportActivity()` 续期；超时 abort。
6. 启动 child runtime；child session **先持久化、后发布** `SubagentSpawned` 事件。
7. **三路竞速**：`Promise.race([完成, 显式转后台请求, 自动转后台定时器])`。转后台时 `taskAbort.detachParent()`，completion promise 在后台继续跑。
8. 完成：聚合 usage、工具调用数、时长；写 output 文件；返回 `AgentCompletedOutput`（子 agent 最终消息）。

### 1.4 完成通知（后台路径）
1. 铸造 XML 通知文本：
```xml
<task-notification>
<task-id>agent_xxx</task-id>
<output-file>/tmp/zcode-agents/.../output.txt</output-file>
<status>completed</status>
<summary>Agent Explore task "搜索代码" completed.</summary>
<result>...子 agent 最终报告全文...</result>
<usage><subagent_tokens>52340</subagent_tokens><tool_uses>17</tool_uses><duration_ms>88432</duration_ms></usage>
</task-notification>
```
2. 投递为父 runtime 命令队列里的 task-notification 命令，**同步入队**（函数签名返回 void，类型系统拒绝 async，防止"假通知"竞态）；写 session ledger。
3. 带 `notified` 单次认领令牌防重复通知（TaskOutput 读取与 tracker 轮询会争抢同一 claim）。
4. **分支代 fencing**：registry 条目盖 `branchGeneration` 章，迟到通知跨分支直接丢弃。

### 1.5 子 agent 的上下文与工具裁剪
**上下文**（`subagent/context-builder.ts`）：system 段固定顺序 = CLI prefix → agent prompt（profile systemPrompt + persistent memory prompt）→ Subagent Notes（cwd/绝对路径等通用约束）→ Subagent Environment（cwd、git、platform、模型身份）；meta_user 段为 AGENTS.md（可选）与日期、skills。

**工具策略**（`subagent/tool-policy.ts`）：
- **所有子 agent 强制剔除 Plan 工具**——注释："子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让 ExitPlanMode 等待用户确认并卡住父 turn"。
- **递归限制**：child runtime 配置 `subagents: { enabled: false }`，且过滤掉 `Agent`/`Task`——**子 agent 不能再生子 agent，深度恒为 1**。
- Explore agent 白名单 `EXPLORE_AGENT_ALLOWED_TOOLS = [Bash, Glob, Grep, Read, WebFetch, WebSearch, TodoWrite]`——白名单刻意不含任何写文件工具，只读语义靠 prompt 约束、Bash 是唯一副作用入口。
- general-purpose 及自定义：`tools: ["*"]` 表示继承父 runtime 可见工具面（再求交、剔除 dispatch 工具）。
- **控制通道**：强制注入 `RespondToCoordinator` 工具——子 agent 主动向父回话的通道（渲染为 `<subagent-message>` XML）。
- **MCP 借用**（`subagent/borrowed-mcp-port.ts`）：child 不拥有连接生命周期，只借父的快照做过滤视图，`close/connect/disconnect` 一律拒绝——"Subagent MCP port cannot mutate parent connection lifecycle"。
- **权限模式**：内置 Explore 缺省 `yolo`（独立只读 PermissionService）；general-purpose 继承父 PermissionService；**项目级 `.zcode/agents/*.md` 里的 permissionMode 会被剥离**（防仓库内容提权，`bootstrap/src/subagents.ts` 的 `sanitizeProjectAgentProfile`）。
- **SendMessage 续跑**：给运行中 agent 发消息 → steer（`coordinator_steer` 呈现）；给已终态 agent 发消息 → 用原 childSessionId 从 event store 恢复并后台续跑新 turn。
- **持久记忆**（`subagent/persistent-memory.ts`）：profile 写 `memory: user|project|local` 后各有记忆根目录；启动时读 MEMORY.md 索引拼进 system prompt。

### 1.6 工具事件镜像
`subagent/tool-event-mirror.ts`：把 child 的工具/权限事件改写后镜像到父会话——`toolCallId` 重写为 `tool_subagent_<agentId>_<childToolCallId>`，附 `agentId/agentType/childSessionId/parentToolCallId/source: "subagent"` 字段；权限请求带 `InteractionRequestOrigin(kind:"subagent")` 使父界面可代答。

### 1.7 Agent 定义文件格式
加载位置（`bootstrap/src/subagents.ts`）：用户级 `<storageRoot>/agents/**/*.md`；项目级 `<工作目录>/.zcode/agents/**/*.md`；插件 `<pluginRoot>/agents/<name>.md`。同名 profile 后加载者覆盖内置（内置 `general-purpose`、`Explore`）。

**frontmatter 字段全列表**（`subagent/profile-frontmatter.ts`）：
| 字段 | 说明 |
|---|---|
| `name` | 必填，agent 类型名 |
| `description` | 必填，进入 Agent 工具描述（模型靠它选型） |
| `tools` | 工具白名单；支持 `*`、`mcp__server__*` |
| `disallowedTools` | 黑名单 |
| `model`/`providerId`/`modelId`/`reasoningLevel` | 模型选择 |
| `color` | UI 身份色 |
| `permissionMode` | `auto` \| `plan`（项目级文件中被强制剥离） |
| `maxTurns` | 限制 turn 数（最终默认 **4**） |
| `memory` | `user` \| `project` \| `local` |
| `background` | 该 agent 总是后台运行 |
| `injectAgentsMd` | 默认 true |
| `skills` | 技能白名单 |
| `mcpServers` | 借用的 MCP server 名列表 |

真实格式示例：
```markdown
---
name: code-reviewer
description: Reviews code for quality, security and maintainability. Use proactively after writing or modifying code.
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
model: glm-4.7
color: green
maxTurns: 10
memory: project
---

You are a senior code reviewer. When invoked:
1. Run git diff to see recent changes
2. Focus on the files the caller mentions
3. Report findings as: severity, file:line, description
Never modify files yourself — report only.
```

### 1.8 核心代码摘录

**Agent 工具 handler**（`tool/handlers/agent.ts`）：
```ts
const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentInputSchema.parse(input);
  const agentType = parsed.subagent_type ?? AgentType.GeneralPurpose;
  if (!context.subagentPort) { /* ConfigurationError: SUBAGENT_UNAVAILABLE */ }
  return context.subagentPort.launch(
    { ...request, runInBackground: parsed.run_in_background === true },
    { signal: context.abortSignal },
  );
};
```
输出格式化：`子agent报告正文` + `agentId: xxx (use SendMessage with to:'xxx' to continue this agent)` + `<usage>` 三段。

**前台 Agent 的三路竞速**（`subagent/runner.ts:302-330`）：
```ts
const winner = await Promise.race([
  guardedCompletionPromise.then((completed) => ({ completed, kind: "completed" as const })),
  ...(backgroundRequestPromise ? [backgroundRequestPromise] : []),
  ...(autoBackgroundTimer ? [autoBackgroundTimer.promise] : []),
]);
if (winner.kind === "backgrounded") {
  taskAbort.detachParent();               // 切断父子取消联动
  activityWatchdog.stop();
  void completionPromise
    .then((completed) => finalizeBackgroundCompletion(options, request, lifecycle, registry, completed))
    .catch((error) => finalizeBackgroundFailure(options, request, lifecycle, registry, error))
    .finally(taskAbort.dispose);
  return createAgentBackgroundedOutput(request, lifecycle);   // { status: "async_launched", ... }
}
```

**child runtime 装配**（`runtime/methods/subagent.ts:239-419` 节选）：
```ts
const childRuntime = new AgentRuntime(
  request.sessionId,                      // childSessionId: subagent_<agentId>
  {
    modelSelection: cloneModelSelection(childSelection),
    workingDirectory: request.workingDirectory,
    subagentContext: { agentPrompt: agentPrompt ?? "" },
    maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns ?? 4,
    parentSessionId: this.sessionId,
    taskType: "subagent_child",
    toolAllowlist: childToolAllowlist,    // 已剔除 Agent/Task/Plan，强制含 RespondToCoordinator
    subagents: { enabled: false },        // 递归限制：子不能再生子
  },
  { /* 继承 eventStore、permissionService、modelFactory、mcpPort(借用)、skillPort(过滤)；
       eventSink(镜像工具事件) */ },
);
return await childRuntime.executeTurn(request.prompt, undefined, {
  abortSignal: options?.signal,
  inputSource: "subagent",               // 首轮输入来自父 Agent，而非真实用户
  inputPresentation: "coordinator_input",
});
```

**工具策略**（`subagent/tool-policy.ts`）：
```ts
const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME];
// 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
// ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
```

## 二、runtime-task 与后台任务

### 2.1 任务类型清单（`core/src/runtime-task/registry.ts`）
```ts
export type RuntimeTaskType =
  | "local_agent"               // 后台/前台子 agent
  | "local_bash"                // Bash run_in_background / 自动转后台
  | "local_workflow"            // legacy Workflow（不可取消）
  | "local_dynamic_workflow"    // CreateWorkflow 发起的 run（可取消）
  | "monitor_mcp";
```

### 2.2 注册表机制
`InMemoryRuntimeTaskRegistry`：纯内存 Map + waiter 集合。`register/update/remove/get/all`；`requestBackground(id)`——把任务标记 isBackgrounded 并唤醒 waiter（**前台 Agent"转后台"的机关**）；`waitForTerminal(id)`；`queueMessage/drainMessages` 消息信箱；`branchGeneration` 盖章 fencing。

### 2.3 统一追踪器：BackgroundTaskTracker
`core/src/tool/executor/background-tasks.ts`：工具输出 `status === "backgrounded"` 或 `async_launched` 时调 `trackBackgroundTask`，按工具名查 `BackgroundTaskLifecycleProvider` 表（每个后台工具声明：1s 轮询快照源、终态直等、可取消），统一发 `BackgroundTaskStarted/Updated/Completed` 事件、写 registry、铸造终态通知。分派：Agent → subagentPort；CreateWorkflow → dynamicWorkflowRunPort；Bash → executionPort。

### 2.4 Bash 后台与 TaskOutput
- `bash-background-lifecycle.ts`：显式 `run_in_background: true` 立即后台；前台 Bash 也可超时后自动转后台。
- TaskOutput 工具：`task_id` 定位；`block: true` 以 100ms 轮询等待。投影按类型分派：bash 读输出文件尾部（最多 8MB，前面以 `[xxKB of earlier output omitted]` 标注）；agent 优先读 registry 结构化内容再回退磁盘文件。

### 2.5 通知到父会话
两条路汇入同一队列：subagent 路径直接 `enqueueParentTaskNotification`；bash/workflow 路径由 tracker 铸造。父 runtime 的 `enqueueBackgroundTaskNotification`（`runtime/methods/background-notifications.ts`）做 shutdown 防御、branchGeneration 校验后入命令队列，并保存 durable 账本。命令在下一个可中断点渲染为 synthetic user message，模型即"收到完成通知"。

## 三、动态工作流与 legacy Workflow

### 3.1 两套体系
1. **Legacy expert workflow**（`core/src/workflow/`）：`createExpertWorkflowDefinition` 定义 8 阶段固定管线（clarify → task_analysis → arch_decompose → env_setup → meta_prompt → exec → final_critic → complete）。`workflow/scheduler.ts` 的 `WorkflowGraphScheduler`：就绪节点并发派发（受 maxConcurrentLoops 限）、Promise.race 收割、连续错误熔断、死锁暂停。**节点执行器是注入的**——每个节点启动独立 child agent session。即 legacy workflow 是「用 subagent 执行 DAG 节点」的编排器。经 legacy `Workflow` 工具后台运行（不可取消）。

2. **Dynamic workflow（dwf）**：模型用 `CreateWorkflow` 工具提交一段 **TypeScript 脚本**。
   - `packages/dynamic-workflow`（纯库）：内嵌 facade `.d.ts` 作为模型面唯一 API：`agent(name?, persona?)` 创建 actor（持久会话）、`Node<T>` thenable、`ask<T>(instructions)`、`log()/report(item, artifactId?)`（journal 化渐进产物，256 条/32KB 上限）、`artifact.file/markdown/chart/table/metrics/board`（交付物与仪表盘）、`phase(name)`（阶段标注，必须字面量、每阶段须含 ask 或 world.run）、`files.glob/read/grep`、`git.changedFiles/diff/status/log`、`world.run(cmd, args)`（journal 化命令执行，argv 固定）、`args`（保存工作流的声明式参数）。
   - 编译器对脚本做 virtual-host typecheck、站点表收集（ask/actor/join 站点、fan-out 候选）、污点解释器求不动点、时序游走，产出 causality graph 供用户确认与缓存。
   - `packages/dynamic-workflow-runtime`（沙箱 harness）：脚本 lower 成 async 函数体，在**子进程 `vm.createContext`** 里执行，NDJSON stdio 桥接 `__host.*` 调用到纯引擎核心；`Date.now/Math.random` 运行期禁令、args 冻结过界一次、journal 使 resume 可重放（crash recovery）。
   - 运行时交互：`CreateWorkflow`（新启动）/`ResumeWorkflowRun`（恢复）/`AmendWorkflow`（修订续跑，已完成 actor 导入缓存）三工具；run 即后台任务；`TaskStop` 可停；终态通知含 reports/artifacts 分节。

**与 subagent 的关系**：两套工作流的执行单元都是子 agent 会话——legacy 是框架排 DAG、每节点一个 agent；dwf 是脚本排 actor、每个 `ask` 一个 agent 会话。

## 四、Node REPL（`js` 工具的执行内核）

- `core/src/repl/node-repl-session.ts`：调用方进程内的持久 JS 执行引擎。`vm.createContext` 构建沙箱 globalThis：tee console、受限 process facade（保护 MCP stdio 协议）、scoped setTimeout、`require`（宿主 realm）、`importModule`（绕开 vm 的 import 限制）、`nodeRepl` API（write/emitImage）。跨多次 run 保持状态。
- **instrument.ts**（206 行）：`parseReplCode`（meriyah parseModule）→ `instrumentForContextPersistence`：因为 top-level await 需要把代码包进 `(async()=>{})()`，顶层 `const/let/function` 会被 IIFE 作用域吃掉；它在**每条顶层声明语句后注入 `globalThis.<name> = <name>;`**，并把最后一条 ExpressionStatement 改写成 `return (...)` 以回显完成值。
- **executors.ts**：`IifeContextExecutor`——`runInContext(wrapped, context, { timeout: 5000 })` 用 **V8 同步执行预算**打断 `while(true){}` 死循环（注释：Promise race 只能取消交还 event loop 的异步代码），再与 AbortSignal race 支持取消。
- 文件头注释明说：**vm 不是安全沙箱，隔离由上层权限与审批 gate 承担**。

## 五、教学简化建议

1. **核心只要四个构件**：① profile（name/description/systemPrompt/tools 四字段，Markdown frontmatter + 正文）；② Agent 工具（schema 带 description/prompt/subagent_type，handler 里 new ChildAgent(profile, prompt).run()）；③ 子 agent =「system prompt = profile.systemPrompt + 环境信息，工具集 = 白名单过滤后的同一套工具」的普通 agent loop——**让读者看到子 agent 与主 agent 共用同一个 loop**，这是最值得教的设计；④ 结果 = 子 agent 最后一条 assistant 文本直接作为 tool result。
2. **第二轮再加"后台"**：`Map<taskId, TaskSnapshot>` 注册表 + status，后台完成时往主 loop 输入队列塞一条 `<task-notification>` synthetic user message。教学点："模型如何通过文本协议感知后台完成"。
3. **第三轮讲三条安全规则**（每条对应真实代码的必然性论证）：禁 Plan 类需要用户交互的工具（会卡死父 turn）；禁 Agent 工具自嵌套（深度恒 1）；工具白名单过滤而非新造。
4. **进阶选讲**：转后台的 Promise.race 模式（10 行讲完"前台 await 与后台任务如何共存"）；SendMessage 的 steer；notified 认领令牌解决"通知 vs 轮询重复投递"；Explore 只读 agent 的白名单设计。
5. **明确告诉读者省掉了什么**：trace 父子链与 branchGeneration fencing、活动看门狗、metadata/output 落盘、MCP/Skill 借用过滤、usage 聚合、自动转后台定时器。
