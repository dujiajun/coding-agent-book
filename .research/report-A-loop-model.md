# 调研报告 A：Agent 主循环与模型层（供第 1、2.1、4.4、6.3 章使用）

来源：ZCode CLI 源码调研（apps/zcode-cli）。所有路径相对 `D:/repos/ZCode/apps/zcode-cli/`。

## 0. 总体架构

`packages/core/src/agent/turn-machine.ts` 定义了一个 10 状态的回合状态机，但它**不是主循环的驱动器，而是主循环的"记录仪"**。真正的驱动逻辑在 `packages/core/src/runtime/`：

- `runtime.ts` + `runtime/agent-runtime.ts`：AgentRuntime 的组装与门面；
- `runtime/methods/turn.ts`：一次用户输入的回合入口；
- `runtime/methods/turn-loop.ts`：`while(true)` 模型步循环（这是"agentic loop"本体）；
- `runtime/methods/turn-model-step.ts`：单次"模型请求 → 解析工具调用"步；
- `runtime/methods/turn-tools.ts`：工具批量执行与结果回灌；
- `runtime/methods/turn-stop.ts`：回合终止判定。

TurnMachine 以不可变风格参与：每次相位推进都 `new TurnMachineImpl(machine.xxx())` 产生新状态，主要用于诊断、Turn 事件和非法转换防护；**控制流本身由 model step 的返回值 `"continue" | "break"` 驱动**。

分层：
- `packages/contracts/`：provider-neutral 协议（消息、内容块、工具调用、流事件、usage）。
- `packages/core/`：runtime 主循环、工具注册表、上下文/系统提示词、compact、subagent。
- `packages/adapters/`：Vercel AI SDK 适配器（`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/openai-compatible`），不裸写 fetch，HTTP 层由 AI SDK 承担，adapters 用自定义 fetch 包装做兼容与错误识别。

## 1. `packages/core/src/agent/` 逐文件职责

| 文件 | 职责 |
|---|---|
| `turn-machine.ts` | `TurnMachineImpl`：回合状态机。方法：`create/start/startModelRequest/receiveModelResponse/scheduleTools/startToolExecution/completeTool/queuePendingInput/requestPermission/resolvePermission/aggregateResults/complete/fail`；非法转换抛 `CoreErrorType.InvalidTurnPhase` |
| `turn-state.ts` | 状态机类型与转换表：`TurnPhase` 10 相位、`TurnState` 全量字段、`ToolCallStateStatus` 6 态、`canTransitionTo()` 合法转换表 |
| `message-history.ts` | `MessageHistoryImpl`：跨回合的 provider 可见历史（`RuntimeMessageEntry[]`）。`init/addUser/addAssistant/addToolResult/addAttachment/replaceMessages/reset`；缓存命中统计；`countContextPrefixMessages` 判定"上下文前缀"边界（compact 后保留段） |
| `message-history-usage.ts` | 从持久化 `TokenUsageInfo` 恢复 input 窗口估算，供冷恢复后的 context meter/compact 阈值使用 |
| `compact-session.ts` | 按压缩边界切片会话消息，可选把保留段重新插回锚点消息之后 |
| `loaded-skills.ts` | 以"provider 可见历史中是否存在一次成功的 Skill 工具调用"作为技能加载判据——历史即模型记忆，compact 挤掉后技能门自动重新关闭 |
| `file-part-hydration.ts` | 把持久化 `FilePart`（附件）恢复为 image/video/file/text 内容块；不支持类型降级为 `[Attached mime: label]` 文本 |
| `read-file-state-hydrator.ts` | resume 时扫描历史中 completed 的 Read/Write/Edit tool part，重建"文件已读水位"（mtimeMs/revisionId/sizeBytes），支撑 Edit 的 stale guard |
| `session-history-hydrator.ts` | 冷恢复主入口。把持久化 `MessageWithParts` 重放为 provider 可见的 `RuntimeMessageEntry` 序列；处理中断工具的合成结果 `"[Tool execution was interrupted before resume]"` |
| `tool-part-order.ts` | 同一 callID 取最新 part，并按 `declarationIndex`（模型声明顺序）排序 provider 侧 calls/results |

## 2. 核心数据结构（`packages/contracts/src/model/index.ts`）

**消息 `ModelInputMessage`**：
```ts
interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;        // string | 内容块数组
  cacheControl?: { type: "ephemeral"; ttl?: "5m"|"1h" };
  toolCalls?: ModelToolCall[];         // assistant 上的工具调用
  toolCallId?: string;                 // tool 消息对应的调用 id
  toolName?: string;
  isError?: boolean;                   // tool 结果错误标记
  providerId?: ModelProviderId;
  modelId?: ModelId;
}
```

**内容块 `ModelMessageContentBlock`**（6 种联合）：`text{text}`、`reasoning{text}`、`image{mediaType, dataUrl}`、`video{...}`、`file{...}`、`resource_link{uri,...}`。

**工具调用 `ModelToolCall`**：`{ id: string; name: string; input: unknown; providerExecuted?: boolean }`——这是 tool_use blocks（Anthropic）与 tool_calls（OpenAI）的统一形态。

**工具契约 `ModelToolContract`**：`{ name, description?, inputSchema(JsonSchema), outputSchema?, strict?, readOnly?, destructive?, concurrentSafe?, needsApproval?, sideEffectScope?, permission?, resultBudget?, maxOutputBytes?, timeoutMs?, providerNative?, execute? }`。`sideEffectScope` 取值 `none|workspace|git|network|system|session|userInteraction`。

**流事件 `ModelStreamEvent`**：`start`、`text_start/text_delta/text_end`、`reasoning_start/delta/end`、`tool_input_start/delta/end`、`tool_call{toolCall}`、`finish{finishReason, usage}`、`error{error}`。

**usage `ModelUsage`**：`{ inputTokens?, outputTokens?, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, serverToolUse? }`。

**模型接口 `Model`**：`{ providerId, modelId, properties(contextWindow 等), optionSpecs(maxOutputTokens/reasoningLevel 档位), options, bind(), generateText(request), streamText(request): AsyncIterable<ModelEvent> }`。

**回合状态 `TurnState`**（`agent/turn-state.ts`）：`{ id, sessionId, turnNumber, phase, traceId, input, modelRequest?, streamingContent, finalResponse?, toolCalls: ToolCallState[], toolResults, scheduledTools, pendingInputs, pendingPermissions, resultType, error?, startedAt, completedAt? }`。工具调用状态机：`scheduled → waiting_permission → running → completed | failed | permission_denied`。

## 3. 回合（Turn）完整流程

### 3.1 入口（`runtime/methods/turn.ts`）
1. 输入封装为 `PromptRuntimeCommand`（priority "next"），进入可取消的运行时命令队列（串行化所有 turn）。
2. 冻结本轮事实（在第一个 await 前读取 Session 模型选择，配置变化只影响下一轮）；
3. 创建 `TurnMachineImpl`、turnAbortScope（用户 Stop 信号）、`createTurnModel()`；
4. 首轮 `ensureContextInitialized()`（构建系统提示词并 `messageHistory.init()`），后续每轮 `rebuildContextPrefix()`；
5. 执行 SessionStart hooks → 发 `TurnStarted` 事件 → UserPromptSubmit hooks（若 hook 阻止，直接 TurnComplete）→ 用户输入进入历史 + 落盘 → 进入 `runRegularTurnLoop()`。

### 3.2 模型步循环（`runtime/methods/turn-loop.ts`）
`while (true)`，每轮迭代是一次 provider 请求：
1. `throwIfTurnAborted`（用户 Stop 检查点）。
2. `modelStepCount > 0` 时消费 steering/队列输入。
3. `microcompactIfNeeded` 与 `autoCompactIfNeeded`；rapid-refill 断路器：compact 后 3 个工具轮内连续 3 次 refill → 终止。
4. 组装工具表（减去 turn 级 denylist）。
5. 注入 system-reminder 附件（todo_reminder、runtime_mode、plan_mode_exit、output_style）。
6. **请求投影**：把 `RuntimeMessageEntry[]` 投影为 provider 消息数组（attachment 渲染成 `<system-reminder>` 包装的 user 消息、cache-control 只放最后一条非 system 消息）。
7. `turnMachine.startModelRequest(...)`；发 `ModelRequest` 事件。
8. `runModelBackedTurnStep()` 返回 `"continue" | "break"`。

### 3.3 单个模型步（`runtime/methods/turn-model-step.ts`）
1. **先持久化 assistant 骨架**（message + step-start part）——"先占坑"设计保证断流后 UI/冷恢复有锚点。
2. 计算 `maxOutputTokens = min(模型声明上限, contextWindow - 估算输入 - 1000)`。
3. `model.streamText(request)` → **for-await 消费归一化流事件**：text_delta 累积+回调 UI；reasoning_delta 聚合；tool_input_delta 增量缓冲（换行或 4096 字符 flush）；`tool_call` 归一化去重后交给 streaming coordinator（**只读工具可立即开始执行**）；finish 记录 finishReason/usage；error 抛出。
4. 错误恢复链（按序）：streaming coordinator 断流恢复（把已接受的工具调用连同结果提交后从锚点重发，预算 10 次）→ Start Plan busy 重试 → 用户取消（持久化部分输出）→ 上下文超窗 → reactive compact 后重试。
5. 成功路径：`extractToolCallsFromResult`；finishReason 为 `length` → 输出截断续写（见 3.7）。
6. 持久化 reasoning/text part；发 `ModelComplete` 事件（content、usage、stopReason、toolCallCount）。
7. 分派：无工具调用 → 终止判定（3.4）；有工具调用 → **先写 assistant 再执行工具**（保证工具结果永远有配对的 tool_use）→ `executeToolCallsForModelStep()`（3.6）。

### 3.4 终止判定（`runtime/methods/turn-stop.ts`）
1. `step-finish` part + assistant 完成态落盘。
2. 有待消费的 guide（用户在响应期间插入的输入）→ 以 user 消息进历史，return "continue"（同一回合继续）。
3. `runStopHooks`：Stop hook 判定应继续 → 注入 hook context，return "continue"（次数限制）。
4. 否则：`turnMachine.complete(modelResponse, "success")`，return "break"。

### 3.5 回合收尾
发 `TurnComplete` 事件（response、tokenCount、usage=所有 ModelComplete 事件的 usage 求和、toolCallCount、duration）→ 记账 → turnNumber++ → 调度 Project Memory 提取（辅助模型）。

### 3.6 工具执行与结果回灌（`runtime/methods/turn-tools.ts`）
1. 每个工具调用持久化 pending tool part（带 declarationIndex）。
2. `scheduleTools()` 生成调度（并行组/依赖）。
3. 执行：executor 内部处理权限（waiting_permission）、并发、超时；取消时为每个 call 生成 ToolCancelled 结果而不是抛出。
4. 按声明顺序遍历结果：`turnMachine.completeTool(id, {success, content})`；**结果回灌** `commitTurnRequestEntries(createRuntimeToolResultEntry(callId, toolName, content, isError))`——错误结果以 `isError: true` 进入（模型看到的是 tool 错误消息而非异常）；发 StreamRecoveryAnchor（断流恢复锚点）。
5. 某结果带 `turnControl.stopTurnAfterResult` → break；否则 return "continue" → 工具结果已在历史里，进入下一轮循环。

### 3.7 stop reason 处理汇总

| finishReason | 处理 |
|---|---|
| `stop` 且无 tool calls | 终止判定（guide/Stop hook/break） |
| `tool-calls` | 提取工具 → 执行 → continue |
| `length` | 输出续写，最多 3 次：注入 user 消息 "Output token limit hit. Resume directly — no apology..."；耗尽抛错 |
| 请求失败型 context exceeded | reactive compact → 重试本步 |
| `unknown` + 空输出 | 记 suspicious empty 并抛 ModelError |
| 用户 abort | cancelled：持久化部分流快照 + `TurnComplete(cancelled)` |

### 3.8 token usage 统计链路
provider usage 经 `normalizeUsage()` 归一 → finish 事件 → `ModelComplete` 事件 → 回合级 `createModelUsageSummaryFromEvents` 求和。总 token 口径：`totalTokens ?? (inputTokens ?? cacheRead+cacheWrite) + outputTokens`；注意 AI SDK v6 的 Anthropic `inputTokens` 已含 cache read/write，不能重复叠加。

## 4. 核心代码片段

### 片段 1：状态机转换表（`packages/core/src/agent/turn-state.ts`）
```ts
export function canTransitionTo(current: TurnPhase, next: TurnPhase): boolean {
  const validTransitions: Record<TurnPhase, TurnPhase[]> = {
    [TurnPhase.Idle]: [TurnPhase.ProcessingInput],
    [TurnPhase.ProcessingInput]: [TurnPhase.AwaitingModelResponse, TurnPhase.Completing],
    [TurnPhase.AwaitingModelResponse]: [TurnPhase.Streaming, TurnPhase.Completing, TurnPhase.Error],
    [TurnPhase.Streaming]: [TurnPhase.SchedulingTools, TurnPhase.AggregatingResults, TurnPhase.Completing, TurnPhase.Error],
    [TurnPhase.SchedulingTools]: [TurnPhase.ExecutingTools, TurnPhase.AwaitingPermission, TurnPhase.Error],
    [TurnPhase.ExecutingTools]: [TurnPhase.AggregatingResults, TurnPhase.AwaitingPermission, TurnPhase.Error],
    [TurnPhase.AggregatingResults]: [TurnPhase.AwaitingModelResponse, TurnPhase.SchedulingTools, TurnPhase.Completing, TurnPhase.Error],
    [TurnPhase.AwaitingPermission]: [TurnPhase.ExecutingTools, TurnPhase.Error],
    [TurnPhase.Completing]: [TurnPhase.Idle],
    [TurnPhase.Error]: [TurnPhase.Idle],
  };
  return validTransitions[current]?.includes(next) ?? false;
}
```

### 片段 2：主循环骨架（`packages/core/src/runtime/methods/turn-loop.ts`，有删节）
```ts
export async function runRegularTurnLoop(this, state): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const compactPhase = state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(/* ... */);
    const autoCompactOutcome = await this.autoCompactIfNeeded(/* CompactReason.ContextLimit */);
    if (autoCompactOutcome === "rapid_refill_blocked") throw createCompactRapidRefillError(/*...*/);
    await this.initializeMcp(state.turnTraceContext);
    const tools = turnDisallowedTools
      ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
      : this.getTools(state.model);
    // 注入 plan_mode_exit / runtime_mode / todo_reminder / output_style 附件 ...
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries, applyCacheControl: true, model: state.model,
    });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(`${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages),
    );
    const result = await runModelBackedTurnStep.call(this, state, { /* ... */ });
    if (result === "break") break;
  }
}
```

### 片段 3：流式响应消费（`packages/core/src/runtime/methods/model.ts`，有删节）
```ts
const modelStream = model.streamText(modelRequest);
try {
  for await (const event of modelStream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        options.onStreamTextDelta?.(event.text);
        await enqueueStreamingEvent({ assistantMessageId, delta: event.text, done: false, kind: "text_delta" });
        break;
      case "reasoning_delta":
        /* 按 id 聚合 reasoning 块 */ break;
      case "tool_input_delta":
        await appendToolInputDelta(event.id, event.delta); break;   // 换行或 4096 字符即 flush 到 UI
      case "tool_call": {
        const [toolCall] = normalizeModelToolCallsForRuntime([event.toolCall]) ?? [];
        if (!toolCall || toolCallIds.has(toolCall.id)) break;        // 按 id 去重
        toolCallIds.add(toolCall.id);
        toolCalls.push(toolCall);
        options.onStreamToolCall?.(toolCall);                        // 只读工具可在此立即开始执行
        break;
      }
      case "finish":
        finishReason = event.finishReason; usage = event.usage;
        await flushAllToolInputDeltas();
        break;
      case "error":
        throw normalizeStreamError(event.error);
    }
  }
}
```

### 片段 4：工具结果回灌（`packages/core/src/runtime/methods/turn-tools.ts`，有删节）
```ts
for (const result of results) {
  const content = stringifyToolResultOutput(result);
  const isError = isErrorForToolResult(result);
  // ... 持久化 tool part (completed/error) 与媒体附件 ...
  commitTurnRequestEntries(this, state.turnRequestState, [
    createRuntimeToolResultEntry(result.toolCallId, result.toolName,
      modelContentForToolResult(result), isError),
  ]);
  // ... 文件变更 checkpoint、stream recovery 锚点 ...
}
const stopTurnResult = results.find((r) => r.turnControl?.stopTurnAfterResult === true);
if (stopTurnResult) { return "break"; }
// 否则 return "continue";
```

**加分教学素材**：`packages/core/src/memory/memory-agent-loop.ts` 的 `runMemoryAgentLoop` 是一个 60 行的完整 mini agent loop（for 循环 → generateText → 无 toolCalls 则 break → 并行执行工具 → tool 消息回灌），是讲清主循环机制的最佳对照实现。

## 5. adapters 模型供应商适配层（`packages/adapters/src/model/`）

**SDK 与 provider 种类**：`AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible"`；由 provider 配置的 `api.type` 映射：`anthropic-messages → createAnthropic`、`openai-responses → createOpenAI(...).responses`、`openai-chat-completions → createOpenAICompatible`。即：任何 Anthropic 协议端点、OpenAI Responses 端点、任意 OpenAI 兼容端点（含 GLM/第三方网关）都能接入。HTTP 层由 AI SDK 发起，adapters 叠加自定义 fetch（业务错误识别、协议兼容、代理）。

**关键文件**：
- `runner.ts`：`AiSdkModelAdapter.createModel()` → 产出 contracts 的 `Model`。
- `runner-stream.ts`（1656 行）：流式主执行器。attempt 循环内：准入（进程级并发闸门）→ idle timeout 保护（默认 600s，每重试 +30s）→ 事件归一化 → 流式 tool input 组装 → **retry 边界**：首个真实 provider 事件之后永不 adapter 级重试（可见输出已提交，重放会让 UI/历史重复），改由 core 的 stream recovery 从锚点重开。
- `runner-normalization.ts`：AI SDK kebab-case 事件 → contracts snake_case `ModelStreamEvent`；`normalizeUsage`。
- `transform.ts`：`toAiSdkMessages()`——provider-neutral 消息 → AI SDK `ModelMessage`；system 提取、tool 消息强制配对、cacheControl → providerOptions。**tool_use blocks vs tool_calls 的差异由 AI SDK 消化**。
- `retry-policy.ts`：默认 maxAttempts = 10+1、base 2000ms、factor 2、max 60s、jitter；env 可覆盖。Unbounded 预算：退避封顶 60s 后无限探测。
- `request-admission.ts`：进程级并发准入（tryAcquire 快路径 / acquire 排队 / release 幂等归还）。

**core 侧**：`createRuntimeModel` 把适配器模型、准入端口、重试预算绑成 runtime 句柄；`createTurnModel` 从 Session Selection 构造。

## 6. 辅助模型

`packages/core/src/model/auxiliary-model-options.ts`：
```ts
const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;
export function auxiliaryModelOptions(model: Model): Required<ModelOptions> {
  return {
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,   // 最低档
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
```
用途：**辅助调用**（compact 摘要、会话标题、project memory 提取、goal 校验等非主循环模型调用）统一压到最低推理档 + 最多 5000 输出 token，控制成本。

## 7. 系统提示词来源（简述，细节见报告 D）

构造入口 `packages/core/src/context/builder.ts` 的 `ContextBuilder.build()`。产物：`systemMessages`（最多 3 条 system 消息，各带 `cacheControl: ephemeral`）+ `metaUserAttachments`（skills_listing 与 context_prefix，以 `<system-reminder>` 包装的 user 消息注入）。stable 身份体：`"You are an interactive ZCode agent that helps users with software engineering tasks."` + 安全声明 + `# Harness` 块。安装时机：`messageHistory.init(buildContextHistoryEntries(contextResult))`——系统提示词作为历史前缀进入 `MessageHistory`，被识别为不可 compact 的前缀。

## 8. 真实默认值/常量一览

| 常量 | 值 | 位置 |
|---|---|---|
| 模型请求重试 | 10 次重试（maxAttempts=11），base 2s，指数 ×2，封顶 60s，jitter | `adapters/src/model/retry-policy.ts` |
| 流 idle 超时 | 600,000ms 基线 + 每次重试 +30,000ms | `contracts/src/config/index.ts` |
| core 断流恢复重试 | `STREAM_RECOVERY_MAX_RETRIES = 10` | `core/src/runtime/methods/streaming-recovery.ts` |
| 输出截断续写 | `MAX_OUTPUT_TOKEN_CONTINUATIONS = 3` | `turn-output-token-continuation.ts` |
| 默认请求 maxOutputTokens | 32,000（模型未声明时） | `model-token-limits.ts` |
| 辅助模型预算 | maxOutputTokens 5,000 + reasoning 最低档 | `core/src/model/auxiliary-model-options.ts` |
| rapid-refill 断路器 | 阈值 3 轮 / 连续 3 次 | `turn-loop-state.ts` |
| subagent maxTurns | 默认 4 | `runtime/methods/subagent.ts` |
| memory 提取 maxTurns | `EXTRACTION_MAX_TURNS = 5` | `runtime/helpers/project-memory-extraction.ts` |
| tool input delta flush | 4096 字符 | `model.ts` |
| goal 心跳 | 15,000ms | `turn.ts` |
| **主循环最大轮数** | **无固定上限**——while(true) 由 abort/终止条件退出 | `turn-loop.ts` |

## 9. 教学简化建议

1. **用 memory-agent-loop 当引入，runtime 主循环当主体**。先给读者 60 行真实存在的循环（请求→工具→回灌→重复），建立心智模型；再讲生产版的增量。
2. **把 TurnMachine 讲成"黑匣子记录仪"而非驱动器**。教学版状态机只需 4 相位：`requesting → streaming → executing_tools → (aggregating → requesting | completing)`。真实代码里状态机是纯函数式的不可变记录，控制流用 continue/break 返回值——"状态机图"与"控制流图"分离是绝佳教学点。
3. **可忽略的工程细节**（脚注带过）：附件/媒体投影、resume 冷恢复水合、rapid-refill 断路器、admission 票据、thinking signature repair、compact preservedSegment 插回。
4. **必须讲透的四个机制**：
   a) **双历史结构**：canonical `MessageHistory`（跨回合持久）+ turn-local `turnRequestState.entries`（本回合请求快照），每次 commit 双写；
   b) **assistant 先落盘、工具结果成对回灌**：保证 tool result 永远有配对的 tool_use，删除它会让下一次请求 400——所有 coding agent 都会踩的坑；
   c) **投影与请求分离**：内存里的 entry（带 metadata/source）在发请求前才投影为 provider 消息，存储形态 ≠ 传输形态；
   d) **分层重试**：adapter 内重试（无可见输出前）→ core stream recovery（有输出后从锚点重放）→ reactive compact（上下文超窗）→ output-token 续写（finishReason=length）。
5. **流处理讲一个 switch 就够**：教学版 for-await 消费 `text_delta/tool_call/finish/error` 四种事件即可。
6. **adapters 章主线**：一个 `Model` 接口 + AI SDK 兜住三种 API 格式 + 重试/idle-timeout/重试边界三件套。
7. **usage 统计讲两句话**：每步 ModelComplete 事件带 usage，回合结束 reduce 求和；"inputTokens 已含 cache"是真实陷阱。
