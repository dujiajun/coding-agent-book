// tinycode/src/tools/edit.ts —— 字符串替换编辑工具（3.2）
// 三原则：严格优先、逐级降级、唯一性。

import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { Tool } from "./registry.js";

function toAbs(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

// 教学版实现两级匹配：精确匹配 → 逐行 trim 匹配。
// 真实系统（edit-matchers.ts）有八级：还有弯引号归一、Read 行号前缀剥离、
// 转义还原、Unicode 还原、缩进弹性、块锚定（首尾行 + 0.8 相似度）。
function findMatch(
  content: string, search: string,
): { index: number; matched: string } | { status: "not_found" } {
  const exact = content.indexOf(search);
  if (exact >= 0) return { index: exact, matched: search };

  // 逐行 trim 匹配：模型经常丢行首尾空白
  const searchLines = search.split("\n").map((l) => l.trim());
  const contentLines = content.split("\n");
  const candidates: number[] = [];
  for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + searchLines.length);
    if (window.every((l, j) => l.trim() === searchLines[j])) candidates.push(i);
  }
  if (candidates.length === 1) {
    const startLine = candidates[0];
    const startIdx = contentLines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0);
    const matchedText = contentLines.slice(startLine, startLine + searchLines.length).join("\n");
    return { index: startIdx, matched: matchedText };
  }
  return { status: "not_found" };
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let pos = content.indexOf(search);
  while (pos >= 0) {
    count += 1;
    pos = content.indexOf(search, pos + search.length);
  }
  return count;
}

export const editTool: Tool = {
  name: "edit_file",
  description:
    "把文件中的一段文本替换为另一段（old_string 必须与文件内容完全一致且唯一）。" +
    "替换所有出现处请设 replace_all: true。修改前必须先用 read_file 读过该文件。支持删除：new_string 传空串。",
  concurrentSafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区根的文件路径" },
      old_string: { type: "string", description: "要被替换的原文，必须与文件内容逐字一致" },
      new_string: { type: "string", description: "替换后的文本，删除时传空串" },
      replace_all: { type: "boolean", description: "替换所有出现处，默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  handler: async (input, ctx) => {
    const { path, old_string: oldString, new_string: newString, replace_all: replaceAll = false } =
      input as { path: string; old_string: string; new_string: string; replace_all?: boolean };
    const abs = toAbs(ctx.cwd, path);
    const content = await readFile(abs, "utf8");

    if (oldString === newString) throw new Error("old_string 与 new_string 相同，文件不会被修改");
    if (!content.includes(oldString.trim()) && !content.includes(oldString)) {
      throw new Error(`old_string 在 ${path} 中未找到。请先用 read_file 确认原文（注意空格与缩进）。`);
    }

    // 唯一性：replace_all 为 false 时多处出现必须报错，引导模型补充上下文
    const occurrences = countOccurrences(content, oldString);
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string 在 ${path} 中出现 ${occurrences} 次，但 replace_all 为 false。` +
        "请提供更多上下文使其唯一，或设 replace_all: true。",
      );
    }

    let updated: string;
    let replaced = 0;
    let rest = content;
    if (replaceAll) {
      // 用函数形式做替换：字符串形式会把 $$、$& 当特殊 token（踩坑！）
      updated = rest.split(oldString).join(newString);
      replaced = occurrences;
    } else {
      const match = findMatch(content, oldString);
      if ("status" in match) {
        throw new Error("old_string 在文件中不存在（已尝试逐行 trim 匹配）。");
      }
      updated = content.slice(0, match.index) + newString + content.slice(match.index + match.matched.length);
      replaced = 1;
    }
    await writeFile(abs, updated, "utf8");
    return `已替换 ${replaced} 处，${path} 更新成功。文件状态已在上下文中，无需读回。`;
  },
};
