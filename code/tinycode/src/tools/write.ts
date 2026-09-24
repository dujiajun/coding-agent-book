// tinycode/src/tools/write.ts —— 写文件工具（3.1）
// 整文件覆盖 + 原子写：先写临时文件再 rename，避免半截文件。

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type { Tool } from "./registry.js";

const MAX_BYTES = 1024 * 1024;

function toAbs(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export const writeTool: Tool = {
  name: "write_file",
  description:
    "把 content 完整写入工作区内文件（整文件覆盖，路径不存在则创建）。" +
    "修改已存在的文件前，必须先用 read_file 读过它。返回 diff 摘要。",
  concurrentSafe: false,   // 写文件不允许与其他调用并行
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区根的文件路径" },
      content: { type: "string", description: "完整的文件内容" },
    },
    required: ["path", "content"],
  },
  handler: async (input, ctx) => {
    const { path, content } = input as { path: string; content: string };
    if (content.length > MAX_BYTES) throw new Error(`content 过大（${content.length} 字节 > ${MAX_BYTES}）`);
    const abs = toAbs(ctx.cwd, path);

    // 教学版不做强制 read-before-write（那是 3.2 的 read-file-state 与 5.3 权限的事），
    // 真实系统在这里校验"读过 + 未过期"，防止模型凭想象盲改。
    const oldText = await stat(abs).then(() => readFile(abs, "utf8")).catch(() => undefined);

    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);   // 原子切换：要么旧文件，要么完整新文件

    const oldLines = oldText === undefined ? 0 : oldText.split("\n").length;
    const newLines = content.split("\n").length;
    const kind = oldText === undefined ? "Created" : "Updated";
    return `${kind} ${path}（${oldLines} → ${newLines} 行）。文件状态已在上下文中，无需读回。`;
  },
};
