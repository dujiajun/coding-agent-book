// tinycode/src/tools/bash.ts —— 命令执行工具（3.4）
// 超时 + 输出截断（保尾部）是三个必选项；Windows 下优先 POSIX shell。

import { spawn } from "node:child_process";
import type { Tool } from "./registry.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;   // 默认 2 分钟
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000; // 单次上限 10 分钟
const MAX_OUTPUT_BYTES = 30_000;      // 内联回传上限，超限保尾部

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;          // stdout + stderr 拼接（各自保尾）
  timedOut: boolean;
}

// 通用命令执行：bash 工具、git 快照（3.5）都从这里走
export async function runCommand(
  command: string,
  opts: { timeout?: number; cwd?: string } = {},
): Promise<CommandResult> {
  const timeout = Math.min(Math.max(1, opts.timeout ?? DEFAULT_BASH_TIMEOUT_MS), DEFAULT_BASH_MAX_TIMEOUT_MS);
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "bash" : "/bin/sh";   // Windows 依赖 Git Bash 提供的 bash
  const args = isWindows ? ["-lc", command] : ["-c", command];

  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(shell, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");   // 真实系统会先优雅终止再清理进程树，教学版直接杀
    }, timeout);

    child.stdout!.on("data", (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(
          `Command timed out after ${timeout}ms. ` +
          "Consider a longer timeout or run_in_background.",
        ));
        return;
      }
      resolvePromise({
        exitCode: code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        output: clipTail(stdout.toString("utf8"), MAX_OUTPUT_BYTES) +
          clipTail(stderr.toString("utf8"), MAX_OUTPUT_BYTES),
        timedOut,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

// 截断保尾部：命令的结论通常在输出的末尾
export function clipTail(text: string, budget: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= budget) return text;
  const kept = buf.subarray(buf.length - budget).toString("utf8");
  const dropped = buf.length - budget;
  return `[${dropped} bytes dropped from the start; conclusions are usually at the end]\n${kept}`;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在工作区根目录执行一条 shell 命令，返回 stdout/stderr 与退出码。" +
    "默认超时 120 秒（可用 timeout 参数调高，上限 600 秒）。输出超长时只保留末尾。",
  concurrentSafe: false,   // 命令可能有任意副作用，永不并行
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeout: { type: "number", description: "超时毫秒数，默认 120000，最大 600000" },
    },
    required: ["command"],
  },
  handler: async (input, ctx) => {
    const { command, timeout } = input as { command: string; timeout?: number };
    try {
      const result = await runCommand(command, { timeout, cwd: ctx.cwd });
      const parts: string[] = [];
      if (result.stdout.trim().length > 0) parts.push(result.stdout.trimEnd());
      if (result.stderr.trim().length > 0) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
      parts.push(`[exit code: ${result.exitCode}]`);
      return parts.join("\n");
    } catch (err) {
      // 超时/启动失败的错误信息写给模型看：失败的同时给出路
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
