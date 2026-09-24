// tinycode/src/main.ts —— 终端入口（1.1 起步，2.1 升级为 Agent）
// 用法：OPENAI_API_KEY=sk-... node src/main.ts "帮我统计 src 下的代码行数"

import { createInterface } from "node:readline/promises";
import { createOpenAICompatibleModel } from "./model.js";
import { runAgentLoop } from "./loop.js";
import { ToolRegistry } from "./tools/registry.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { bashTool } from "./tools/bash.js";

const model = createOpenAICompatibleModel({
  baseUrl: process.env.TINYCODE_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  modelId: process.env.TINYCODE_MODEL ?? "gpt-4o-mini",
  contextWindow: Number(process.env.TINYCODE_CONTEXT_WINDOW ?? 128_000),
});

const registry = new ToolRegistry();
for (const tool of [readTool, writeTool, editTool, globTool, grepTool, bashTool]) {
  registry.register(tool);
}

const SYSTEM_PROMPT = [
  "You are tinycode, a hands-on coding agent that works inside the user's workspace.",
  "Prefer dedicated tools over guessing: read before editing, search before assuming.",
  "Group independent read-only calls; run mutating calls one at a time.",
].join("\n");

const task = process.argv.slice(2).join(" ") || (await ask("任务："));
const messages = [
  { role: "system" as const, content: SYSTEM_PROMPT },
  { role: "user" as const, content: task },
];

process.stdout.write("tinycode 正在工作…\n");
const result = await runAgentLoop({ model, tools: registry.list(), messages });

process.stdout.write(`\n${result.finalText}\n`);
process.stdout.write(`\n（${result.steps} 个模型步，历史 ${result.messages.length} 条消息）\n`);

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
