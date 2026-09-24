// tinycode/src/tools/read.ts —— 读文件工具（3.1）
// 输出采用 cat -n 风格（行号 + Tab + 内容），与主流 Coding Agent 的约定一致。

import { readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import type { Tool } from "./registry.js";

// 教学版上限：256KB / 2000 行（真实系统另加 25k token 预算，超预算生成 partial view）
const MAX_BYTES = 256 * 1024;
const MAX_LINES = 2000;

function toAbs(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export const readTool: Tool = {
  name: "read_file",
  description:
    "读取工作区内一个 UTF-8 文本文件的内容，输出带行号（cat -n 风格）。" +
    "路径相对工作区根目录。默认最多读 2000 行 / 256KB，可用 offset/limit 分段读取。",
  concurrentSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区根的文件路径，如 src/model.ts" },
      offset: { type: "number", description: "起始行号（从 1 开始），可选" },
      limit: { type: "number", description: "读取行数，可选" },
    },
    required: ["path"],
  },
  handler: async (input, ctx) => {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
    const abs = toAbs(ctx.cwd, path);
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error(`${path} 是目录，请用 glob_file 列出其中的文件`);
    if (info.size > MAX_BYTES) throw new Error(`文件过大（${info.size} 字节 > ${MAX_BYTES}），请用 offset/limit 分段读取`);

    const text = await readFile(abs, "utf8");
    const allLines = text.split("\n");
    const start = Math.max(1, offset ?? 1);
    const end = Math.min(allLines.length, start - 1 + (limit ?? MAX_LINES));
    const numbered = allLines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}\t${line}`)
      .join("\n");

    const notes: string[] = [];
    if (end < allLines.length) {
      notes.push(`[文件共 ${allLines.length} 行，当前显示到第 ${end} 行。用 offset=${end + 1} 继续读取。]`);
    }
    if (notes.length > 0) return `${numbered}\n${notes.join("\n")}`;
    return numbered;
  },
};
