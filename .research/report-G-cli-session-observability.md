# 调研报告 G：CLI 入口、会话持久化、可观测性与评测（供第 2.6、6.1、6.2 章使用）

来源：ZCode CLI 源码调研。路径相对 `apps/zcode-cli/`。

**重要澄清**：`packages/core/src/repl/` 不是交互式 REPL 循环，而是 agent 的内建 `node_repl` 工具（vm 沙箱执行 JS）。真正的交互式终端 UI 在 `packages/tui/`。

## 一、启动流程

### 1.1 包拓扑
- `packages/cli/package.json` → `"bin": { "zcode": "./dist/zcode.cjs" }`。esbuild 打成单文件 CJS，支持 Node SEA 单二进制。
- 依赖方向：`cli` → `bootstrap`（服务装配）→ `core`（AgentRuntime）→ `contracts`（类型/端口）+ `adapters`（Node 实现）+ `tui`（交互 UI）+ `telemetry`（OTel）。

### 1.2 main.ts：进程引导的 8 个步骤（`packages/cli/src/main.ts`，122 行）
1. 设进程名。
2. **环境清洗**：把用户 shell 注入的 `NODE_ENV`、代理、证书变量封存（只在 Bash 工具子进程里恢复）。
3. **识别调用形态**：协议模式（app-server/agent-server）与 TUI 模式。协议模式安装 stdout 严格帧边界——注释原话："任意依赖的一行普通日志都会触发传输层 JSON 解析崩溃"，所以把进程级 console.* 全部改道 stderr。
4. 协议生命周期（AbortSignal、requestShutdown、complete）。
5. SEA 运行时工具。
6. plugin-host 捷径。
7. 动态加载 run.ts 并执行。
8. finally 收口（等 warning 刷完、退出看门狗）。

### 1.3 run.ts：命令路由（`node:util parseArgs`，无第三方 CLI 库）
- `parseArgs({ strict: true, allowPositionals: true })`。全局选项含 `-p/--prompt`、`--resume`、`--continue`、`--mode`、`--output-format`(text/json/stream-json)、`--cwd`、`--disallowedTools` 等。
- **子命令 switch**：`commandName = positionals[0] ?? "tui"`——**不带子命令 = 进 TUI**。
  - help / version / doctor / login / logout / commands / plugin(s) / skills / tui / agent-server / app-server。
- **无子命令但带 `-p`** → headless 单提示模式 `runPrompt`。

### 1.4 TUI 与 headless
- TUI：`!stdin.isTTY` 直接退出；渲染器是 `@mbears/opentui-core`（30 FPS）。启动先渲染 StartupScreen，首帧后才异步加载会话元数据并挂载真正的 App。**App 是懒创建的**——第一次 `getApp()` 才 create；`/new`、`/resume`、`/fork` 通过 `replaceApp()` 换掉当前 App。
- headless（-p）：加载 .env → resolveResumeSession → 遥测准备 → createApp → submitPrompt → 输出结果/NDJSON 事件流 → closeApp（6 秒超时）。

### 1.5 createZCodeApp：装配线全貌（`bootstrap/src/app/create-app.ts`，1290 行）
按序装配（每步有 StartupTimer.mark）：配置解析（5 层合并）→ logger → sessionId + 根 TraceContext → 存储根目录 → 子代理 profiles / 插件 / 内置技能 → **打开 SQLite session store（含版本化迁移）** → 项目权限模式 → runtimeConfig（MCP servers、hooks 信任）→ PermissionService → artifact store → MCP adapter → ExecutionPort → model adapter → **new AgentRuntime(sessionId, runtimeConfig, deps)**（约 30 个端口/依赖）→ 各 facade → 返回 ZCodeApp。

**"端口缺席则整族能力不注册"的条件展开模式**值得单独讲——它是插件化能力的通用手法。

## 二、AgentRuntime 与会话

- `AgentRuntime` 类体只放字段初始化；其余 60+ 公开方法全部由 `installAgentRuntimeMethods(AgentRuntime)` 原型挂载——每个方法一个文件（`runtime/methods/` 下 50+ 文件）。
- **一个 AgentRuntime = 一个 session**。多会话：TUI/协议服务器持有多个 ZCodeApp；子代理/工作流 actor 建 child runtime。
- 生命周期 = 惰性：构造后不落库；首条输入才首次持久化。
- **"session 对象"在内存中就是 runtime 里的一组字段**（messageHistory、readFileState、turnNumber、activeTurn、命令队列）；**在磁盘上就是 SQLite 行**。没有独立的 Session 类——**runtime 即会话**。
- 权限模式是"执行状态"：`{mode, planEnabled}` 写成 session_entry，恢复时读回。

## 三、会话持久化

### 3.1 存储：SQLite，不是 JSONL
默认路径 `~/.zcode/cli/db/db.sqlite`。实现：`adapters/src/storage/session-store/sqlite-session-store.ts`（1022 行）+ `migrations.ts`（930 行）。

`0001_base_session_store` 的表结构：
```sql
create table if not exists session (
  id text primary key,
  project_id text not null,
  workspace_id text,
  parent_id text,          -- fork 链
  trace_id text,
  task_type text,
  slug text not null,
  directory text not null,
  title text not null,
  revert text,             -- rewind / 分支切割（JSON）
  permission text,
  time_created integer not null,
  time_updated integer not null,
  time_compacting integer,
  time_archived integer
);
create table if not exists message (
  id text primary key,
  session_id text not null references session(id) on delete cascade,
  time_created integer not null,
  time_updated integer not null,
  data text not null       -- 整条消息 JSON
);
create table if not exists part (
  id text primary key,
  message_id text not null,
  session_id text not null,
  data text not null       -- 消息部件 JSON：文本/工具调用/时间线等
);
create table if not exists session_entry (
  id text primary key,
  session_id text not null references session(id) on delete cascade,
  type text not null,      -- 模型选择 / 执行状态 / goal 校验 ...
  data text not null
);
-- 还有 todo、permission（按 project 的权限记录）、input_history（↑ 键回忆）、local_setting、schema_migration
```

### 3.2 resume 两条入口
CLI 层（`cli/src/resume.ts`）：`--resume <id>` 直接用；`--continue` 调 `resolveLatestSession({directory})` 找**同工作目录最近的根会话**。TUI 里 `/resume` 走列表选择。

Core 层真正恢复在 `core/src/runtime/methods/resume.ts` 的 `resumeFromStore`：
```ts
export async function resumeFromStore(this, options) {
  const persistedSession = await this.sessionStore.getSession(this.sessionId);
  if (!persistedSession || persistedSession.time.archived !== undefined) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`);
  }
  const messages = await this.sessionStore.messages({ sessionID: this.sessionId });
  // session.revert 的 rewind/分支切割四元组 + branchGeneration 决定哪些历史行是"活"的
  this.branchGeneration = session.revert?.branchGeneration ?? 0;
  this.workingDirectory = session.directory;
  this.messageHistory = new MessageHistoryImpl();
  this.contextBuilder = null;
  this.contextInitialized = false;
  // hydrateReadFileStateFromSession + hydrateMessageHistoryFromSession 重建内存态
  // 恢复 checkpoint、mode、todo、target(goal)
  // 发 SessionResumed 事件 + 跑 SessionStart hooks（"resume" 原因）
}
```

### 3.3 fork / 分支
`core/src/runtime/methods/session-fork.ts`（1487 行）提供四种 fork：
- `forkWorkspaceFromCheckpoint`（workspace checkpoint 分叉，可回滚文件）
- `forkStableConversationAtMessage` / `forkConversationBeforeMessage`（走 **commitForkBundle 原子提交**：子 session 行 + 复制消息 + session_entry 一次事务落库）
- `createSelectionSideConversation`（划词副屏小会话）

`createForkedSession` 建 child 行（`parent_id = 父 sessionId`），复制消息并返回新旧 id 映射，补一条 fork notice 时间线 part。同会话内的 edit/retry 不建新会话，而是写 `session.revert` 的 branch cut。

## 四、REPL 工具 internals（供 3.4 章）

- **instrument.ts**：`instrumentForContextPersistence`——top-level await 需要把代码包进 IIFE，顶层声明会被作用域吃掉；在**每条顶层声明语句后注入 `globalThis.<name> = <name>;`**，并把最后一条 ExpressionStatement 改写成 `return (...)`。
- **executors.ts**：`runInContext(wrapped, context, { timeout: 5000 })` 用 **V8 同步执行预算**打断死循环——注释：Promise race 只能取消交还 event loop 的异步代码，`while(true){}` 会把线程永久占住；vm 的同步执行预算由 V8 interrupt 检查实现。

## 五、可观测性

### 5.1 结构化日志（JSONL 文件）
`adapters/src/logging/index.ts`：日志目录 `~/.zcode/cli/log`，按日文件 `zcode-YYYY-MM-DD.jsonl` 追加（**写日志失败静默吞掉**——"Logging must never break the agent execution path"）。每行 JSON 字段：timestamp/level/event/module/message/**traceId/sessionId/turnId/spanId/parentSpanId**/toolCallId/durationMs/status/context/error；脱敏；保留期清理。

### 5.2 TraceContext（自研轻量 tracing 契约）
`contracts/src/tracing/tracer.ts`：`TraceContext { traceId, queryId?, spanId?, parentSpanId?, sessionId?, turnId?, attributes }`；`createRootTraceContext` / `createChildTraceContext` / AsyncLocalStorage 的 `runWithContext` / `traceContextToLogContext`。

### 5.3 OTel 真实接入（packages/telemetry）
依赖 `@opentelemetry/api` + sdk-trace-base + exporter-trace-otlp-proto。
- `prepareZCodeTelemetryEnv`——**只有配置了 `OTEL_EXPORTER_OTLP_ENDPOINT` 且未禁用才动态 import OTLP exporter**，disabled 路径零 SDK 加载：
```ts
export async function prepareModelTelemetryEnv(env, options = {}) {
  if (!resolveOtlpTraceEndpoint(env) || isExplicitlyDisabled(env.ZCODE_MODEL_TELEMETRY_ENABLED)) {
    return env;                       // 未配置 OTLP → 零 SDK 加载
  }
  // ... 设备身份解析、动态 import("./otlp-exporter.js")
}
```
- `agent-trace-runtime.ts`（1600+ 行）：`startTurn/startStep/startTool/startCompaction` 返回强类型 SpanWriter，属性命名空间 `zcode.execution.*`。
- core 侧：`RuntimeTelemetryFacade`——port 缺省时落到一整套 **NOOP Writer**（保证无遥测时零分支成本）。

### 5.4 Model I/O 轨迹（rollout）
`adapters/src/model/runner-debug.ts`：每次模型请求/响应写 `model-io-<session>.jsonl` 到 `~/.zcode/cli/rollout/`。增量记录（相对上一请求只记新增消息）、reasoning 全量、data URL 脱敏。**这就是评测/回放的原始轨迹**。

### 5.5 packages/debug：本地诊断台
Hono + Vite/React + vis-timeline 的只读查看器，消费 log/*.jsonl、db.sqlite、会话事件 JSONL；内置 **MITM 网络抓包代理**（127.0.0.1:4184）。

## 六、评测基础设施

**结论：仓库内没有 SWE-bench/Terminal-bench 类评测 harness**。存在的"评测基建"：
1. **`tools/prompt-trajectory/`**：四个子命令——`record`（从参考请求 fixture 录制轨迹）、`record-prompt`、`derive`（派生变体）、`model-io`（**把 rollout 的 model-io JSONL 转成 anthropic_trajectory.json 评测格式**）。
2. **`scripts/shadow-replay.mjs`（影子重放对账）**：把本机真实库全量会话喂给冷恢复管线，输出守恒对账报告（崩溃数/助手文本缺失/用户输入不匹配…）。注释写明"每阶段上线门槛 = 全量重放无崩溃、无静默丢弃"。
3. **`--memory-bench`**：跑 prompt 并等记忆提取全部完成——记忆系统基准入口。
4. **E2E 支撑**：`ZCODE_E2E_COVERAGE=1`（V8 覆盖率）、`ZCODE_E2E_FS_FAULTS`（存储层故障注入）。
5. **stream-json 输出**：`--output-format stream-json` 逐事件 NDJSON，外部 harness 可驱动与断言。

## 七、配置系统

### 7.1 五层合并（低 → 高）
`adapters/src/config/config-factory.ts` 头注释即权威：
1. **System**：`DefaultRuntimeConfig`（mode=build、storage.dir=~/.zcode、toolConcurrency.maxConcurrency=10、hooks 默认关闭…）
2. **User 文件**：`~/.zcode/cli/config.json`
3. **Project 文件**：从 workspace 根到 cwd 每层目录探测 `zcode.json` 与 `.zcode/config.json`
4. **Env**：`ZCODE_*`
5. **CLI overrides**（最高）

**特例规则**：MCP servers 合并时 user 遮蔽 project（与全局字段相反），`serverSources` 记录每个 server 来自哪层。

### 7.2 ~/.zcode 目录布局
```
~/.zcode/
├── cli/                          # CLI 存储根
│   ├── config.json               # 用户配置
│   ├── db/db.sqlite              # ★ 会话库
│   ├── log/zcode-YYYY-MM-DD.jsonl
│   ├── rollout/                  # model-io-<session>.jsonl（模型 I/O 轨迹）
│   ├── artifacts/                # 工具产物
│   ├── exec/                     # Bash 执行输出根
│   ├── agents/                   # 子代理输出根
│   ├── memories/projects/<slug>-<hash>/memory/  # 项目记忆
│   └── plugins/                  # 插件安装/缓存
├── v2/                           # 桌面 Host 侧
└── mailbox/                      # 会话邮箱
```

## 八、容易被写错的事实核对清单

- 会话存储是 **SQLite 而非 JSONL**；
- `core/src/repl` 是 node_repl 工具而非交互 REPL；交互 TUI 基于 OpenTUI 而非 Ink/blessed；
- 无 argparse 第三方库（用 node:util parseArgs）；
- OTel 仅在配置 OTLP endpoint 后动态加载；
- `~/.zcode/v2` 属桌面 Host 而非 CLI。

## 九、教学简化建议

1. **命令解析**：保留 `node:util parseArgs` + 手写 switch 路由（真实做法，比引 yargs 更有教学价值）；选项砍到 5 个。
2. **启动装配**：教学版提炼成一张"端口表"（sessionStore/executionPort/fileSystemPort/httpClientPort/modelFactory/eventStore）+ 一个 60 行 `createApp(config, ports)` 工厂。**"端口缺席则整族能力不注册"**值得单独讲。
3. **会话持久化**：SQLite 选型本身即为教学正解（对照 JSONL：消息/部件/分支切割天然需要查询与事务）。教学版只需 `session/message/part/session_entry` 四张表 + 一个版本化迁移 runner。**不要**在书里用 JSONL 会话文件——与真实源码相悖。
4. **可观测性**：教学版做两层——(a) 字段化 JSONL 日志（traceId/sessionId/turnId 贯穿）；(b) OTel span 门的惰性加载 + NOOP fallback 双模式。
5. **评测**：如实告诉读者"该仓库没有公开 benchmark harness"，以 prompt-trajectory + shadow-replay 作为"用生产轨迹做评测"的务实范式。
6. **配置**：五层合并讲成"默认值 → 用户 → 项目 → 环境变量 → CLI 参数"的洋葱图。
