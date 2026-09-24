# 附录：术语表与速查

> 本章导览：全书术语的中英对照、真实系统（ZCode CLI）工具与关键默认值速查、tinycode 配套代码索引。

## 术语表

| 术语 | 英文 | 定义 | 详见 |
| --- | --- | --- | --- |
| 回合 | Turn | 用户一次输入触发的完整处理过程，可含多次模型请求与工具执行 | 2.1 |
| 模型步 | Model Step | 回合内的一次"请求模型 → 解析响应" | 2.1 |
| Agent 循环 | Agent Loop | 请求模型 → 执行工具 → 结果回灌 → 再请求的循环 | 2.1 |
| 工具调用 | Tool Call | 模型发起的一次工具使用请求，含名称、参数、唯一 id | 1.2 |
| 工具结果回灌 | Tool Result Commit | 把工具执行结果作为 tool 消息写回历史供下一轮请求 | 2.1 |
| 系统提示词 | System Prompt | 每次请求都携带的固定指令段，由多个 section 分节构建 | 2.3 |
| 上下文窗口 | Context Window | 模型单次请求可容纳的最大 token 数 | 1.4 |
| 上下文前缀 | Context Prefix | 压缩时永不摘要的历史头部（系统提示词、技能清单等） | 2.4 |
| 压缩 | Compact | 将旧对话历史摘要化以腾出上下文空间 | 2.4 |
| 微压缩 | Microcompact | 零模型调用的本地瘦身：清空旧工具结果 | 2.4 |
| 记忆 | Memory | 跨会话持久的项目知识：MEMORY.md 索引 + 单事实文件 | 2.3 |
| 系统提醒 | System Reminder | 以 `<system-reminder>` 包裹注入的运行时消息总线 | 2.3 |
| 合成消息 | Synthetic Message | 非真实用户产生、注入给模型的消息（如后台任务通知） | 2.5、5.6 |
| 子代理 | SubAgent | 拥有独立上下文的完整 Agent 实例，由 Agent 工具派生 | 2.5 |
| 代理配置 | Agent Profile | 用 Markdown frontmatter 定义的子代理类型 | 2.5 |
| 模型上下文协议 | MCP (Model Context Protocol) | Agent 与外部工具服务器之间的标准协议 | 2.2 |
| 钩子 | Hook | 在 Agent 生命周期固定时刻执行的外部命令 | 4.1 |
| 技能 | Skill | 按需加载的 Markdown 指令包（渐进披露） | 4.2 |
| 自定义命令 | Custom Command | Markdown 定义的斜杠命令（prompt 模板） | 4.2 |
| 插件 | Plugin | 打包 skills/commands/hooks/MCP 的可安装扩展 | 4.3 |
| 权限模式 | Collaboration Mode | build / edit / plan / yolo 四种人在回路密度 | 5.3 |
| 权限规则 | Permission Rule | 工具名 + 内容模式（精确 / `prefix:*` / `*`）的三元组 | 5.3 |
| 计划模式 | Plan Mode | 只读探索、整体审批执行的协作模式（flag 而非 mode） | 5.2 |
| 目标 | Goal | 带预算与独立完成性校验的会话级长程任务 | 5.4 |
| 定时任务 | Automation (Cron) | 按 cron/delayMinutes 触发的周期性自主任务 | 5.5 |
| 后台任务 | Background Task | 会话内不阻塞对话的长任务（Bash/子代理/工作流） | 5.6 |
| 动态工作流 | Dynamic Workflow | 模型编写的 TypeScript 编排脚本，actor 间协作 | 5.7 |
| 断流恢复 | Stream Recovery | 有可见输出后从"已提交工具结果"锚点重放的恢复机制 | 6.3 |
| 轨迹 | Trace / Rollout | 以 traceId 贯穿的请求/工具/日志记录链 | 6.1 |
| 评测 | Eval | 用固定用例集衡量 Agent 行为质量的体系 | 6.2 |
| 已读水位 | Read File State | 会话级"读过哪些文件、读到时内容为何"的追踪表 | 3.2 |
| 检查点 | Checkpoint | 文件变更的回滚点，支撑 rewind | 3.5、2.6 |
| 分支切割 | Branch Cut | 会话 rewind 产生的分叉标记（持久化在 session.revert） | 2.6 |

## 工具速查（真实系统 ZCode CLI）

以下为 `apps/zcode-cli` 内置工具面速查。真实代码中工具共 30+ 个，按功能分组列出最常用者：

| 工具 | 用途 | 关键参数 | 关键限制（真实默认值） |
| --- | --- | --- | --- |
| Read | 读文件/图片/PDF | file_path, offset, limit, pages | 256KB / 25k token；图片最长边 2000px |
| Write | 整文件覆盖 | file_path, content | 强制 read-before-write + 原子写 |
| Edit | 字符串替换编辑 | file_path, old_string, new_string, replace_all | 八级匹配；多处出现需 replace_all |
| Glob | 文件名模式搜索 | pattern, path | 上限 100 条，按 mtime 排序 |
| Grep | 内容正则搜索 | pattern, path, glob, output_mode | 底层 ripgrep；模型可见 20KB |
| Bash | 执行命令 | command, timeout, run_in_background | 默认 120s / 上限 600s；内联输出 30KB |
| WebFetch | 抓网页并提炼 | url, prompt | 预批准域名直返；缓存 15 分钟 |
| WebSearch | 联网搜索 | query, allowed/blocked_domains | 依赖 provider 原生搜索 |
| TodoWrite / TodoRead | 任务清单 | 整表替换 | 全量替换语义；session 内状态 |
| Agent (Task) | 派生子代理 | prompt, subagent_type, run_in_background | 结果 120KB；深度恒为 1 |
| Skill | 加载技能正文 | skill, args | 上限 100KB |
| AskUserQuestion | 结构化提问 | questions[]（1–4 题） | 答案以 modify 决策注入 |
| EnterPlanMode / ExitPlanMode | 计划模式切换 | plan, allowedPrompts | plan 上限 20,000 字符 |
| TaskOutput / TaskStop | 读/停后台任务 | task_id, block | block 轮询 100ms；默认 32,000 字符 |
| CronCreate / CronList / CronUpdate / CronDelete | 定时任务 | cron 或 delayMinutes, prompt | automation 轮内禁止再创建 |
| SendMessage | 向子代理续发消息 | to, message | 可复活已终态的 agent |

### 关键默认值速查

| 项 | 值 | 出处（相对 apps/zcode-cli） |
| --- | --- | --- |
| 模型请求重试 | 10 次，base 2s ×2 封顶 60s + jitter | `packages/adapters/src/model/retry-policy.ts` |
| 流空闲超时 | 600s（每次重试 +30s） | `packages/contracts/src/config/index.ts` |
| 断流恢复预算 | 10 次 | `packages/core/src/runtime/methods/streaming-recovery.ts` |
| 输出截断续写 | 3 次 | `turn-output-token-continuation.ts` |
| 压缩阈值 | 窗口 − 21K − 13K（200K 窗口 = 166K） | `packages/core/src/compact/policy.ts` |
| microcompact 触发 | 阈值 ×0.9（且省 ≥256 token 才执行） | `packages/core/src/compact/microcompact.ts` |
| 工具并发上限 | 10 | `packages/core/src/tool/scheduler.ts` |
| 工具结果默认预算 | 100KB（head 截断） | `executor/result-serialization.ts` |
| Bash 内联输出 | 30KB（落盘上限 5GB） | `tool/handlers/bash.ts` |
| 子代理默认 maxTurns | 4 | `runtime/methods/subagent.ts` |
| 记忆提取 | 每 turn 最多 5 轮；索引 200 行 / 25K 字符 | `memory/extraction.ts`、`memory/index-content.ts` |
| 技能清单预算 | 20,000 字符 | `context/sections/skills.ts` |
| AGENTS.md 单文件上限 | 100KB | `packages/adapters/src/context/index.ts` |
| Hook 输出上限 | 32,768 字节；阻断退出码 = 2 | `contracts/src/hooks` |
| MCP 工具超时 | 30s（不可覆盖） | `core/src/mcp/index.ts` |
| Goal objective 上限 | 4,000 字符 | `contracts/src/tools/target.ts` |
| 定时任务 delayMinutes | 1–525,600 | `contracts/src/tools/automation.ts` |

## tinycode 配套代码索引

`code/` 目录下的贯穿项目，按章节生长：

| 文件 | 诞生章节 | 内容 |
| --- | --- | --- |
| `src/model.ts` | 1.1 → 1.3 → 4.4 | fetch 调 API → SSE 流式 → Provider 抽象与本地模型 |
| `src/types.ts` | 1.2 | 消息 / 内容块 / 工具调用类型 |
| `src/loop.ts` | 2.1 | Agent 循环：终止、并发调度、abort |
| `src/tools/registry.ts` | 2.1 | 工具注册表与声明式并发 |
| `src/mcp.ts` | 2.2 | 最小 stdio MCP 客户端与桥接 |
| `src/context.ts` | 2.3 | 分节系统提示词 + AGENTS.md |
| `src/memory.ts` | 2.3 | MEMORY.md 索引与记忆文件 |
| `src/compact.ts` | 2.4 | 压缩阈值 / 摘要 / 历史替换 |
| `src/subagent.ts` | 2.5 | profile 解析与子代理运行 |
| `src/session.ts` | 2.6 | 会话持久化与恢复 |
| `src/tools/read.ts` `write.ts` `glob.ts` | 3.1 | 文件系统工具 |
| `src/tools/edit.ts` + `src/tools/read-file-state.ts` | 3.2 | 编辑匹配与已读水位 |
| `src/tools/grep.ts` | 3.3 | 内容搜索 |
| `src/tools/bash.ts` + `src/tools/repl.ts` | 3.4 | 命令执行与 vm 执行器 |
| `src/tools/git.ts` | 3.5 | git 只读封装与白名单 |
| `src/hooks.ts` | 4.1 | 事件 + matcher + 退出码协议 |
| `src/skills.ts` | 4.2 | 技能发现与按需加载 |
| `src/plugins.ts` | 4.3 | 清单解析与组件合并 |
| `src/permission.ts` | 5.3 | 规则匹配 / 模式判定 / 询问 |
| `src/features/todo.ts` `plan.ts` `goal.ts` `cron.ts` `background.ts` `workflow.ts` | 5.1–5.7 | 功能范式 |
| `src/observability.ts` | 6.1 | traceId + JSONL 日志 |

## 延伸阅读

- **ZCode 仓库**：本书真实系统的完整源码，Agent CLI 位于 `apps/zcode-cli/`；各章"源码对照"给出的路径均相对该目录。
- **MCP 规范**：Model Context Protocol 官方文档——2.2 节协议细节的权威来源。
- **Anthropic / OpenAI 官方文档**：1.2 节工具调用、1.4 节 prompt cache 的第一手资料。
- **ReAct 论文**（Yao et al., 2022）：2.1 节循环模式的思想源头。
- **ripgrep**：3.3 节 Grep 工具的底层引擎，其性能设计值得单独阅读。
- **SQLite 文档**：2.6 节会话存储选型的依据；WAL 模式与事务语义对多进程访问尤其重要。
