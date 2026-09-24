// tinycode/src/tools/git.ts —— Git 快照与只读判定（3.5）
// 真实系统没有这个文件：快照住在上下文构建层、白名单住在权限层；
// 教学版把它们收拢在这里，替读者把"Git 相关的关注点"归档到一个门口。

import { runCommand } from "./bash.js";

// 会话起点的 git 快照：拼出注入系统提示词的那段文本（对应 env-info.ts 的职责）
export async function buildGitSnapshot(cwd: string): Promise<string | null> {
  const inside = await runCommand("git rev-parse --is-inside-work-tree", { cwd }).catch(() => null);
  if (!inside || inside.exitCode !== 0 || inside.output.trim() !== "true") {
    return null;                                    // 不是 git 仓库，注入环节跳过
  }
  const run = async (cmd: string) => (await runCommand(cmd, { cwd })).stdout.trim();
  const branch = await run("git branch --show-current");
  const dirty = (await run("git status --porcelain")) !== "" ? "(dirty)" : "(clean)";

  return [
    "gitStatus: This is the git status at the start of the conversation.",
    "Note that this status is a snapshot in time, and will not update during the conversation.",
    `Current branch: ${branch}`,
    `Status: ${dirty}`,
    "Recent commits:",
    await run("git log --oneline -5"),
  ].join("\n");
}

// 只读判定：真实系统的版本精确到 flag 并带回调复核（git reflog delete 能改历史），
// 教学版到子命令为止
const READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "branch", "ls-files", "rev-parse",
]);

export function isReadonlyGitCommand(args: string[]): boolean {
  return args.length > 0 && READONLY_SUBCOMMANDS.has(args[0]);
}

export async function git(args: string[], cwd: string) {
  const result = await runCommand(`git ${args.join(" ")}`, { cwd });
  return {
    readonly: isReadonlyGitCommand(args),   // 权限层据此决定免审批或弹窗
    ...result,
  };
}
