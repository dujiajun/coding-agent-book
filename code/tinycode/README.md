# tinycode —— 贯穿教学项目（核心阶段快照）

本目录是《手把手教你从零构建 Coding Agent》贯穿项目 tinycode 的**核心阶段**可运行快照，对应书中第 1 部分（模型调用）、2.1（Agent 循环）与 3.x（核心工具）各章的代码清单。

## 目录结构与章节对应

| 文件 | 对应章节 | 内容 |
| --- | --- | --- |
| `src/types.ts` | 1.2 / 1.3 | 消息、工具调用、归一化流事件、Model 接口 |
| `src/model.ts` | 1.1 → 1.3 | OpenAI 兼容 Provider：非流式、SSE 流式解析、重试 |
| `src/loop.ts` | 2.1 | Agent 循环：配对回灌、length 续写、声明式并发调度 |
| `src/tools/registry.ts` | 2.1 | 工具接口（含 concurrentSafe 声明）与注册表 |
| `src/tools/read.ts` | 3.1 | 读文件（行号输出、分段、大小上限） |
| `src/tools/write.ts` | 3.1 | 写文件（整文件覆盖、原子写） |
| `src/tools/edit.ts` | 3.2 | 字符串替换编辑（唯一性校验、两级匹配） |
| `src/tools/glob.ts` | 3.1 | 文件名模式搜索 |
| `src/tools/grep.ts` | 3.3 | 内容正则搜索 |
| `src/tools/bash.ts` | 3.4 | 命令执行（超时、输出截断保尾部、runCommand 通用封装） |
| `src/tools/git.ts` | 3.5 | git 快照与只读白名单 |
| `src/main.ts` | 1.1 / 2.1 | 终端入口：装配模型与工具，跑一轮 Agent 任务 |

## 运行

需要 Node.js ≥ 20 与一个 OpenAI 兼容 API（OpenAI、GLM、本地 Ollama/vLLM 均可）：

```bash
npm install
npx tsc -p tsconfig.json --noEmit   # 类型检查

# 云端模型
export OPENAI_API_KEY=sk-...
node --experimental-strip-types src/main.ts "统计 src 目录下所有 TypeScript 文件的行数"

# 本地模型（Ollama）
export TINYCODE_BASE_URL=http://localhost:11434/v1
export TINYCODE_MODEL=qwen2.5-coder:7b
node --experimental-strip-types src/main.ts "把 src/tools/glob.ts 里的 MAX_RESULTS 改成 200"
```

## 与真实系统的差距

这是**教学版**：省略了真实系统的权限审批、read-file-state 已读水位、工具结果落盘、hooks、会话持久化等全部加固。每处省略在对应章节正文中都有"工程细节"提示框说明真实系统（ZCode CLI）的做法与动机。请勿直接用于生产。

## 后续阶段

MCP（2.2）、上下文构建与记忆（2.3）、压缩（2.4）、子代理（2.5）、持久化（2.6）、权限（5.3）与功能范式（5.x）的清单分散在对应章节正文中，可直接誊抄扩展本项目；对应阶段的完整快照随书稿修订逐步补入本目录。
