// tinycode/src/model.ts —— OpenAI 兼容 Provider 实现（1.3）
// 供应商差异（请求格式、SSE 事件名）全部关在本文件内部。

import type {
  Model, ModelEvent, ModelRequest, ModelResult, ToolCall, ToolDef, TokenUsage,
} from "./types.js";

export interface ProviderConfig {
  baseUrl: string;   // 例：https://api.openai.com/v1；本地模型 http://localhost:11434/v1
  apiKey: string;
  modelId: string;
  contextWindow: number;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOpenAITool(tool: ToolDef) {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function fromOpenAIToolCall(raw: OpenAIToolCall): ToolCall {
  let input: unknown = {};
  try {
    input = raw.function.arguments ? JSON.parse(raw.function.arguments) : {};
  } catch {
    input = { _raw: raw.function.arguments };  // 参数不是合法 JSON 时原样交给上层报错
  }
  return { id: raw.id, name: raw.function.name, input };
}

function toUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  return {
    inputTokens: typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : undefined,
    outputTokens: typeof raw.completion_tokens === "number" ? raw.completion_tokens : undefined,
  };
}

interface ChatChoiceMessage {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export function createOpenAICompatibleModel(config: ProviderConfig): Model {
  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`模型 API 返回 ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    providerId: "openai-compatible",
    modelId: config.modelId,
    contextWindow: config.contextWindow,

    async generateText(request: ModelRequest): Promise<ModelResult> {
      const data = await post({
        model: config.modelId,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools.map(toOpenAITool) } : {}),
      }, request.signal);
      const choice = (data.choices as Array<{ message: ChatChoiceMessage }>)[0];
      return {
        text: choice.message.content ?? "",
        toolCalls: (choice.message.tool_calls ?? []).map(fromOpenAIToolCall),
        usage: toUsage(data.usage as Record<string, unknown> | undefined),
      };
    },

    async *streamText(request: ModelRequest): AsyncIterable<ModelEvent> {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.modelId,
          messages: request.messages,
          ...(request.tools ? { tools: request.tools.map(toOpenAITool) } : {}),
          stream: true,
        }),
        signal: request.signal,
      });
      if (!response.ok || !response.body) throw new Error(`模型 API 返回 ${response.status}`);

      // SSE 解析（1.1）：按行拆 data: 帧；工具调用增量先在缓冲区攒完整再产出
      const toolBuf = new Map<number, { id: string; name: string; args: string }>();
      const emitted = new Set<string>();
      let finishReason = "stop";
      let usage: TokenUsage | undefined;

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;  // 忽略不完整/非 JSON 帧
          }
          const delta = (chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason?: string }> | undefined)?.[0];
          if (!delta) continue;
          const d = delta.delta;
          if (typeof d.content === "string" && d.content.length > 0) {
            yield { type: "text_delta", text: d.content };
          }
          for (const tc of (d.tool_calls ?? []) as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>) {
            const buf = toolBuf.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: "", args: "" };
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name += tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
            toolBuf.set(tc.index, buf);
          }
          if (delta.finish_reason) finishReason = delta.finish_reason;
          if (chunk.usage) usage = toUsage(chunk.usage as Record<string, unknown>);
        }
      }

      // 流结束：产出攒好的工具调用（去重），再发 finish
      for (const buf of [...toolBuf.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (emitted.has(buf.id)) continue;
        emitted.add(buf.id);
        let input: unknown = {};
        try {
          input = buf.args ? JSON.parse(buf.args) : {};
        } catch {
          input = { _raw: buf.args };
        }
        yield { type: "tool_call", toolCall: { id: buf.id, name: buf.name, input } };
      }
      yield { type: "finish", finishReason, usage };
    },
  };
}

// 请求级重试（1.3）：只覆盖"还没有任何可见输出"的失败
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, maxAttempts = 4, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 8_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
