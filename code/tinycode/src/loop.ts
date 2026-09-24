// tinycode/src/loop.ts —— Agent 循环（2.1）：全书的核心
// 不变量：assistant 声明的每个 tool call，后面必然跟着同 id 的 tool 结果消息。

import type { Message, Model, ToolCall } from "./types.js";
import type { Tool } from "./tools/registry.js";

const DEFAULT_MAX_STEPS = 40;   // 打转保险丝，正常任务远用不到
const MAX_CONTINUATIONS = 3;    // finishReason === "length" 的续写上限，与真实系统一致

export interface LoopResult {
  messages: Message[];  // 完整历史：下一回合接着用，也是持久化的原料
  finalText: string;    // 模型最后一段可见回答
  steps: number;        // 实际执行的模型步数
}

export async function runAgentLoop(options: {
  model: Model;
  tools: Tool[];
  messages: Message[];        // 初始历史，以本轮用户消息结尾
  signal?: AbortSignal;
  maxSteps?: number;
}): Promise<LoopResult> {
  const messages = [...options.messages];
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  let continuations = 0;
  let finalText = "";
  let step = 0;
  while (step < maxSteps) {
    options.signal?.throwIfAborted();             // 用户 Stop 的检查点
    step += 1;
    const stepOut = await consumeModelStream(options.model, messages, options.tools, options.signal);
    finalText = stepOut.text;
    // 先落盘：assistant 连同它声明的工具调用一起进入历史（"先占坑"）
    messages.push({
      role: "assistant",
      content: stepOut.text,
      ...(stepOut.toolCalls.length > 0 ? { toolCalls: stepOut.toolCalls } : {}),
    });
    if (stepOut.toolCalls.length > 0) {
      // 再回灌：结果与声明成对，然后进入下一个模型步
      messages.push(...(await executeToolCalls(stepOut.toolCalls, options.tools, options.signal)));
      continue;
    }
    if (stepOut.finishReason === "length" && continuations < MAX_CONTINUATIONS) {
      continuations += 1;
      messages.push({ role: "user", content: "Output token limit hit. Resume directly — no apology." });
      continue;
    }
    break;   // 无工具调用、无需续写：模型认为任务完成，循环终止
  }
  return { messages, finalText, steps: step };
}

async function consumeModelStream(
  model: Model, messages: Message[], tools: Tool[], signal?: AbortSignal,
): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string }> {
  let text = "";
  let finishReason = "stop";
  const toolCalls: ToolCall[] = [];
  const stream = model.streamText({
    messages,
    // 只把名字、描述、schema 发给模型——handler 留在本地，永远不上云
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    signal,
  });
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;              // 真实系统在这里同步刷新终端 UI
        break;
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "finish":
        finishReason = event.finishReason;
        break;
      case "error":
        throw event.error;               // 请求级失败交给外层重试策略
    }
  }
  return { text, toolCalls, finishReason };
}

// ---------- 调度：声明式并发（2.1 第六节） ----------

// 把一轮回来的工具调用分组：concurrentSafe 的进同一组用 Promise.all 并发，
// 其余的各自独占一组按序执行——"两个 Edit 互斥"不需要任何锁。
export function groupToolCalls(calls: ToolCall[], tools: Tool[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let parallelRun: ToolCall[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (tool?.concurrentSafe) {
      parallelRun.push(call);
    } else {
      if (parallelRun.length > 0) {
        groups.push(parallelRun);
        parallelRun = [];
      }
      groups.push([call]);               // 非并发安全的调用独占一组
    }
  }
  if (parallelRun.length > 0) groups.push(parallelRun);
  return groups;
}

async function executeToolCalls(
  calls: ToolCall[], tools: Tool[], signal?: AbortSignal,
): Promise<Message[]> {
  const results: Message[] = [];
  for (const group of groupToolCalls(calls, tools)) {
    // 组内并发：Promise.all 保持元素顺序；组间串行：上一组全部完成才开始下一组
    results.push(...(await Promise.all(group.map((c) => runOneToolCall(c, tools, signal)))));
  }
  return results;
}

async function runOneToolCall(
  call: ToolCall, tools: Tool[], signal?: AbortSignal,
): Promise<Message> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    // 结构性失败：名字不存在。把错误当结果回灌，让模型自己纠正
    return { role: "tool", toolCallId: call.id, content: `Error: no such tool: ${call.name}`, isError: true };
  }
  if (signal?.aborted) {
    return { role: "tool", toolCallId: call.id, toolName: tool.name, content: "Error: cancelled", isError: true };
  }
  try {
    const output = await tool.handler(call.input, { signal, cwd: process.cwd() });
    return { role: "tool", toolCallId: call.id, toolName: tool.name, content: output };
  } catch (err) {
    // 执行性失败：异常同样降级为结果，而不是让整个回合崩溃
    const message = err instanceof Error ? err.message : String(err);
    return { role: "tool", toolCallId: call.id, toolName: tool.name, content: `Error: ${message}`, isError: true };
  }
}
