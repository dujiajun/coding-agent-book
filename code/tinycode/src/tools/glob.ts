// tinycode/src/tools/glob.ts —— 文件名模式搜索工具（3.1）
// 支持 ** / * / ? 的简单 glob，按修改时间倒序，上限 100 条。

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Tool } from "./registry.js";

const MAX_RESULTS = 100;

function toAbs(cwd: string, path?: string): string {
  const p = path ?? ".";
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// 把 glob 模式翻译成正则：** 跨目录，* 不跨目录，? 匹配单个字符
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;                       // ** → 任意（含 /）
      } else {
        re += "[^/]*";             // * → 不跨目录
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

async function walk(root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_RESULTS * 4) return;   // 多收一些，排序后裁剪
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;                                     // 无权限/不存在的目录直接跳过
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
}

export const globTool: Tool = {
  name: "glob_file",
  description:
    "按文件名模式搜索工作区文件，返回按修改时间倒序的相对路径列表（上限 100 条）。" +
    "模式示例：src/**/*.ts、*.json、**/*.test.js。",
  concurrentSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 src/**/*.ts" },
      path: { type: "string", description: "搜索根目录（相对工作区根），默认工作区根" },
    },
    required: ["pattern"],
  },
  handler: async (input, ctx) => {
    const { pattern, path } = input as { pattern: string; path?: string };
    const root = toAbs(ctx.cwd, path);
    const files: string[] = [];
    await walk(root, files);

    const re = globToRegExp(pattern);
    const matched = files.filter((f) => re.test(relative(ctx.cwd, f).split("\\").join("/")));
    const withMtime = await Promise.all(
      matched.map(async (f) => {
        try {
          return { file: f, mtimeMs: (await stat(f)).mtimeMs };
        } catch {
          return { file: f, mtimeMs: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);   // 最近修改优先
    const top = withMtime.slice(0, MAX_RESULTS).map((x) => relative(ctx.cwd, x.file).split("\\").join("/"));

    const truncatedNote = withMtime.length > MAX_RESULTS ? `\n（共 ${withMtime.length} 条，已截断到 ${MAX_RESULTS} 条）` : "";
    return top.length > 0 ? `${top.join("\n")}${truncatedNote}` : `没有匹配 ${pattern} 的文件`;
  },
};
