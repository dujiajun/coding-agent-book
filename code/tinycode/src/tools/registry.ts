// tinycode/src/tools/registry.ts —— 工具接口与注册表（2.1）
// 关键设计：并发安全性靠声明（concurrentSafe），不靠调度器理解工具语义。

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;              // 工作区根目录（绝对路径）
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;   // JSON Schema：模型照它生成参数
  concurrentSafe: boolean;                // 声明式并发：只读无副作用才允许并行
  handler: (input: unknown, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  list(): Tool[] {
    return [...this.tools.values()];
  }
  defs() {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
}
