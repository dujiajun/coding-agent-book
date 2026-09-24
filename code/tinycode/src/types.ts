// tinycode/src/types.ts —— 消息、工具调用与模型接口的统一类型（1.2 / 1.3）
// 形状按业务需要定义，不照抄任何一家供应商的线上格式。

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;        // 模型生成的配对凭证：assistant 声明与 tool 结果靠它成对
  name: string;
  input: unknown;    // JSON 对象，形状由工具的 inputSchema 约定
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];  // assistant 消息携带：模型发起的工具调用
  toolCallId?: string;     // tool 消息携带：本条结果回应哪一次调用
  toolName?: string;
  isError?: boolean;       // 工具执行出错时置 true，错误同样要回灌
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  messages: Message[];
  tools?: ToolDef[];
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

// 归一化后的流事件语言（1.3）：所有供应商的原始流都被翻译成这四种
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "finish"; finishReason: string; usage?: TokenUsage }
  | { type: "error"; error: unknown };

export interface Model {
  readonly providerId: string;    // "openai-compatible" / "anthropic" / …
  readonly modelId: string;
  readonly contextWindow: number; // 压缩阈值（2.4）的计算基础
  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}
