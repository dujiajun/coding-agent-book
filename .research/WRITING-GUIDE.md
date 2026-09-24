# 全书写作规范（写作 agent 必读）

本文件约束 `coding-agent-book/src/` 下所有章节的写作。目标：33+ 章出自多个作者之手，读起来必须像一个人写的。

## 一、语言与文风

- 简体中文。技术名词首次出现给英文原文，如"回合（Turn）"。此后只用中文或只用英文名词皆可，但同一概念全书同名。
- 面向**会编程但没做过 Agent 的程序员**。假设读者懂 TypeScript 基本语法和异步，不懂机器学习。
- **用户明确要求：不要纠结代码语法细节，专注功能实现本身。** 不要解释"什么是 interface"、"async/await 怎么用"；把篇幅花在机制、数据流、设计动机上。
- 句子完整，避免电报体；多用"它做什么、为什么这样做"，少用"值得注意的是"这类填充语。
- 每章篇幅 220–450 行 markdown。

## 二、章节文件规范

1. 文件第一个字符是 `# X.Y 标题`，标题必须与 `src/SUMMARY.md` 完全一致。
2. 标题下是引用块导览：`> 本章导览：一到三句话说清本章解决什么问题、学到什么。`（骨架里已有，可润色不可删除。）
3. **删除** `> ✍️ **待撰写**...` 行和所有 `（待撰写）` 占位。
4. `##` 小节标题：骨架里列出的小节标题是建议性的。若你重排小节，必须覆盖骨架全部知识点；新增 `##` 小节不得超过 2 个。
5. 每章末尾必须有 `## 小结`（5–8 行，浓缩全章 + 一句"下一章预告"式的衔接，如果存在下一章）。
6. mermaid 图：每章至少 1 张（架构图用 flowchart，时序用 sequenceDiagram，状态机用 stateDiagram-v2）。图内文字用中文，节点 id 用英文。

## 三、每章的内容结构（推荐但不强制逐条对齐）

1. **问题**：这一章要解决的真实矛盾是什么（2-3 段）。
2. **机制**：概念如何工作——配 mermaid 图 + 最小教学实现代码。
3. **真实系统怎么做**：引 ZCode 源码路径（相对 `apps/zcode-cli/`，如 `packages/core/src/tool/registry.ts`）+ 关键代码摘录（每段 ≤30 行）+ 设计动机。真实常量值（如 Bash 超时 120s）是全书质感所在，尽量引用并标注来源文件。
4. **工程细节/踩坑**：用提示框：
   - `> **工程细节**：...`（真实系统的加固，教学版省略）
   - `> **踩坑**：...`（源码注释里记录的真实事故）
   - `> **注**：...`（澄清）
5. **小结**。

## 四、代码规范

- 语言 TypeScript，Node.js 内置模块优先（`node:fs/promises`、`node:child_process`、`node:http`），教学项目用原生 `fetch`。
- 平实写法：interface + 普通函数 + class 皆可；**不用**装饰器、条件类型、泛型体操、enum（用字符串字面量联合）。类型标注保留关键处（参数与返回值），局部变量类型可省略。
- 中文注释只写"为什么/约束"，不写"这行在干什么"。每段代码 ≤40 行；超过就拆成多段，段间用文字衔接。
- 代码都要有名字（如 `tinycode/src/loop.ts`），并在文字中说明它属于贯穿项目的哪个文件。
- 真实系统摘录要注明出处：`（packages/core/src/runtime/methods/turn-loop.ts，有删节）`。

## 五、贯穿项目 tinycode 的既定布局（不得偏离）

见 `src/conventions.md` 的表格。各章教学代码的文件归属：

- 1.1 `src/model.ts`（最小请求）→ 1.2 增加 `src/types.ts` + 工具调用 → 1.3 重构 `src/model.ts`（Provider 抽象）→ 1.4 无代码
- 2.1 `src/loop.ts` + `src/tools/registry.ts` → 2.2 `src/mcp.ts` → 2.3 `src/context.ts` + `src/memory.ts` → 2.4 `src/compact.ts` → 2.5 `src/subagent.ts` → 2.6 `src/session.ts`
- 3.1 `src/tools/read.ts`、`write.ts`、`glob.ts` → 3.2 `src/tools/edit.ts` + `src/tools/read-file-state.ts` → 3.3 `src/tools/grep.ts` → 3.4 `src/tools/bash.ts` + `src/tools/repl.ts` → 3.5 `src/tools/git.ts`
- 4.1 `src/hooks.ts` → 4.2 `src/skills.ts` → 4.3 `src/plugins.ts` → 4.4 `src/model.ts` 扩展
- 5.1 `src/features/todo.ts` → 5.2 `src/features/plan.ts` → 5.3 `src/permission.ts` → 5.4 `src/features/goal.ts` → 5.5 `src/features/cron.ts` → 5.6 `src/features/background.ts` → 5.7 `src/features/workflow.ts`
- 6.1 `src/observability.ts` → 6.2–6.4 无固定文件（方法论文为主，可给小型脚本清单）

前一章已"写过"的代码在新章中只引用函数签名/一行调用，不重复贴全文。

## 六、事实纪律（最高优先级）

1. 每个作者会拿到 `.research/report-*.md` 调研报告。**报告中标注的路径、常量、行为是你唯一的事实来源**；需要更多细节时可以直接读 `D:/repos/ZCode/apps/zcode-cli/` 下的源码，但不得凭记忆编造 ZCode 的实现细节。
2. ZCode 的机制描述必须与报告一致；报告明确说"教学简化建议"的部分，正文可以采纳。
3. 教学版代码是你自己写的，自由度大，但要与报告描述的真实行为语义一致。
4. 不确定的 ZCode 细节宁可写抽象描述（"真实系统还处理了若干边界情况"），也不编造常量或文件名。
5. 引用其他章节用「见 2.3 节」格式，章节编号以 `src/SUMMARY.md` 为准。

## 七、术语表（全书统一）

回合/Turn、模型步/model step、工具调用/tool call、Agent Loop、上下文窗口/context window、token、提示词/prompt、系统提示词/system prompt、压缩/Compact、微压缩/microcompact、记忆/Memory、子代理/SubAgent、配置/profile、钩子/Hook、技能/Skill、插件/Plugin、权限模式/mode（build、edit、plan、yolo）、人在回路/human-in-the-loop、轨迹/trace、评测/eval、合成消息/synthetic message、工具结果回灌/tool result 回灌。

## 八、跨章衔接约定

- 第 1 章教"一次调用"，2.1 章教"循环"；2.1 开头要承接 1.2 的单次工具调用。
- 2.3 讲系统提示词与记忆，2.4 讲压缩，两章共享"上下文是稀缺资源"的叙事。
- 5.3 权限是其他功能章（5.2 plan、5.5 cron）的依赖，后两者引用它而不重复展开。
- 6.3（失败模式）汇总 1.3（重试）、2.4（压缩失败）、2.1（循环终止）中埋的伏笔，可回指。
- 第 7 部分是议论文，不写代码，引用前面章节结论。
