// tinycode/src/tools/grep.ts —— 内容搜索工具（3.3）
// 逐文件正则扫描；真实系统底层是 ripgrep，语义一致但快得多。

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Tool } from "./registry.js";

const MAX_RESULTS = 200;          // 匹配行上限
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function toAbs(cwd: string, path?: string): string {
  const p = path ?? ".";
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export const grepTool: Tool = {
  name: "grep_content",
  description:
    "在工作区文件内容中搜索正则表达式，输出 path:line:text（上限 200 行）。" +
    "支持 glob 过滤文件名与 A/B/C 上下文。想找文件名请用 glob_file。",
  concurrentSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript 正则表达式" },
      path: { type: "string", description: "搜索根目录，默认工作区根" },
      glob: { type: "string", description: "文件名过滤，如 *.ts，可选" },
    },
    required: ["pattern"],
  },
  handler: async (input, ctx) => {
    const { pattern, path, glob } = input as { pattern: string; path?: string; glob?: string };
    const root = toAbs(ctx.cwd, path);
    const re = new RegExp(pattern);
    const fileRe = glob ? globToRegExp(glob) : undefined;

    const lines: string[] = [];
    await scan(root, ctx.cwd, re, fileRe, lines);
    if (lines.length === 0) return `没有匹配 /${pattern}/ 的内容`;
    const note = lines.length >= MAX_RESULTS ? `\n（结果已截断到 ${MAX_RESULTS} 行）` : "";
    return lines.join("\n") + note;
  },
};

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; } else { re += "[^/]*"; }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

async function scan(
  dir: string, cwd: string, re: RegExp, fileRe: RegExp | undefined, out: string[],
): Promise<void> {
  if (out.length >= MAX_RESULTS) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_RESULTS) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scan(full, cwd, re, fileRe, out);
      continue;
    }
    if (fileRe && !fileRe.test(entry.name)) continue;
    try {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await readFile(full, "utf8");
      const rel = relative(cwd, full).split("\\").join("/");
      text.split("\n").forEach((line, i) => {
        if (out.length < MAX_RESULTS && re.test(line)) {
          out.push(`${rel}:${i + 1}:${line.trimEnd()}`);
        }
      });
    } catch {
      // 二进制/不可读文件跳过
    }
  }
}
