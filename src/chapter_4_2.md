# 4.2 Skill 与自定义命令：按需指令包

> 本章导览：模型的领域知识不该全部塞进系统提示词。Skill 把知识写成带元数据的 markdown 文件，先给模型一份清单，模型判断需要时才加载正文；自定义命令再给它们一个 `/xxx` 的参数化入口。本章讲清 SKILL.md 格式、发现机制、渐进披露的预算设计，以及命令与 Skill 的关系。

## 问题：指令太多，上下文太小

每个 Coding Agent 都会遇到同一个矛盾：**用户想让模型懂的东西无穷多，上下文窗口却有限**。你的团队有内部框架的用法、公司特有的部署流程、某个遗留系统的目录导览——都写成说明书给模型看？一份就是几千 token，十份就把系统提示词撑爆了，而且大部分会话根本用不上其中任何一份。

更微妙的是"给"的时机。系统提示词在**每次请求**都全额付费（见 1.4 节的缓存与 2.3 节的上下文工程），而一份 React 性能优化指南在一个改 shell 脚本的会话里是纯浪费。

Skill 的解法叫**渐进披露（progressive disclosure）**，分两层：

1. **元数据层**：所有已安装技能的"名称 + 一句话描述"清单常驻上下文，预算封顶 20000 字符——这是"目录页"；
2. **正文层**：模型判断某个技能与当前任务相关时，调用 `Skill` 工具把正文（上限 100KB）加载进来——这是"翻到那一章"。

```mermaid
flowchart LR
    A["磁盘上的<br/>SKILL.md 文件"] --> B["发现与扫描<br/>（启动时）"]
    B --> C["元数据清单<br/>≤ 20000 字符<br/>常驻上下文"]
    C -->|"模型判断相关<br/>调用 Skill 工具"| D["加载正文<br/>≤ 100KB<br/>skill_content 包装"]
    D --> E["模型按正文执行"]
```

目录页便宜，正文昂贵且按需。这个两段式设计是 Skill 机制的全部灵魂，后面所有细节都在为它服务。

## SKILL.md：格式与发现

一个技能就是一个目录，目录里必须有 `SKILL.md`。文件由 YAML frontmatter 加 markdown 正文组成，frontmatter 是扁平的标量字段：

```yaml
---
name: dynamic-workflows
description: "Use when writing, debugging, or resubmitting a dynamic-workflow script for the CreateWorkflow tool..."
when_to_use: "Only for CreateWorkflow scripts. A single delegation ... belongs to the Agent tool instead."
---

（正文：给模型看的操作指南，可以引用同目录下的脚本与文档）
```

（示例来自真实系统 `packages/bundled-skills/skills/dynamic-workflows/SKILL.md`，有删节。）

三个字段的分工：

- **`name`**：必需。模型调用 Skill 工具时用它指名。
- **`description`**：必需，超过 1024 字符直接报错（`packages/adapters/src/skills/index.ts` 的 `MAX_DESCRIPTION_LENGTH = 1024`）。它是目录页里的那句话，**模型靠它决定要不要加载这个技能**。
- **`when_to_use`**：可选，会追加在 description 之后进入模型可见清单。当"这是什么"和"什么时候用它"需要分开说时用它——尤其是排除性条件（"只用于……，单一委派请改用别的工具"）。

正文没有 schema 约束——它就是 prompt 的一部分，想写多细写多细，还可以放配套脚本（正文里指路"运行本目录下的 check.py"），模型加载后能用 Bash 执行它们。

**发现机制**决定"模型能看到哪些技能"。ZCode 按 `resolveDefaultSkillRoots`（`packages/adapters/src/skills/roots.ts`）从四个来源收集技能根目录，优先级从高到低：

1. **显式配置**：`skills.roots` 指定的目录；
2. **用户级**：`~/.zcode/skills` 与 `~/.agents/skills`（后者是跨工具兼容目录）；
3. **项目级**：从当前工作目录**向上每一层**直到 git worktree 根，每层检查 `.zcode/skills` 与 `.agents/skills`——monorepo 里子目录可以有自己专属的技能；
4. **插件**：插件携带的技能根目录，技能名带命名空间（`pluginName:skillName`），见 4.3 节。

两条容易被忽略的规则：用户级与兼容目录是**合并而不是回退**——用户可能同时装了原生和兼容两套技能，同名时按目录优先级取先者；扫描时若根目录自身放着 SKILL.md，根自身算一个技能，其下一层子目录各算一个。

> **工程细节**：插件来源的技能**一律不跟随符号链接**。源码注释给出了理由：symlink 可以指向 `~/.aws/credentials`，"拒绝链接即拒绝逃逸"。用户级目录保持跟随，因为那里是用户自己的地盘。信任边界跟着目录的信任级别走，这是扩展机制设计的一贯手法。

禁用某个技能不需要删文件：配置里的 `skillOverrides` 以 SKILL.md 绝对路径为键，显式关掉单个技能。

## 渐进披露：清单先行，正文按需

**元数据层**的实现是一个上下文分节构建器（`packages/core/src/context/sections/skills.ts`，有删节）：

```ts
const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;

function buildSkillsContent(skills: SkillMetadata[], budget: number): string {
  const lines = [
    "The following skills are available for use with the Skill tool:",
    "",
  ];
  const sortedSkills = [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)),
  );
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill, MAX_DESCRIPTION_CHARS));
  const full = [...lines, ...skillLines].join("\n");
  if (full.length <= budget) {
    return full;
  }
  // 超预算降级：只保留名称和路径，描述全部丢弃
  const namesOnly = sortedSkills.map(
    (skill) => `- ${skillDisplayName(skill)} (file: ${skill.path})`,
  );
  return [...lines, ...namesOnly].join("\n");
}
```

三个设计决定值得咀嚼。每条描述被截断到 **250 字符**——目录页要的是"判断相关性"，不是完整文档。清单总预算 **20000 字符**——按每条 300 字符估算，能容纳约 60 个技能，超出普通用户的安装量。超预算时的降级是**整体降级**（所有描述丢弃、只留名称与路径），而不是逐条挤掉——保证清单形态一致，模型不会误以为"没描述的技能不重要"。

这份清单以 `<system-reminder>` 包装的 user 消息注入（meta_user 上下文段，见 2.3 节的附件机制），随上下文前缀一起被缓存保护。

**正文层**是 `Skill` 工具。模型从清单里挑中一个名字，调用工具，适配器读文件、剥掉 frontmatter、把正文包进标准信封（`packages/core/src/tool/handlers/skill.ts`，有删节）：

```ts
const MAX_SKILL_BYTES = 100_000;

return [
  `<skill_content name="${loaded.metadata.name}">`,
  `# Skill: ${loaded.metadata.name}`,
  "",
  expandSkillContextVariables(loaded.content, loaded.baseDirectory),
  "",
  `Base directory for this skill: ${loaded.baseDirectory}`,
  "Relative paths in this skill are relative to this base directory.",
  loaded.truncated ? "[Skill content truncated]" : "",
  "</skill_content>",
].filter((line) => line.length > 0).join("\n");
```

信封解决了两个问题。**第一，路径锚定**：正文里写"运行 scripts/check.py"，模型需要知道 scripts 相对于哪里——信封显式声明 base directory。`${ZCODE_SKILL_DIR}` 变量也**只在此时**展开为这个目录：技能写作者可以在正文里引用这个占位符，但它不能在清单阶段就展开，因为那时还不知道"当前技能"是谁。**第二，边界标记**：`<skill_content>` 标签让模型（和解析器）能分清"哪些指令来自技能正文"，超 100KB 截断时也有一行明示。

> **注**：Skill 工具本身是只读、免审批的（`readOnly: true, needsApproval: false`）。加载指令没有副作用，有副作用的是后续照着指令执行的动作——那些会走各自的工具权限。技能正文里的"指令"并不比用户消息里的指令更可信，这套一致性很重要。

**description 怎么写**，直接决定技能会不会被触发。三条实操建议：第一，把触发条件写进去，用"Use when..."开头，让模型做的是**条件匹配**而非语义联想——"Use when writing, debugging, or resubmitting a dynamic-workflow script"精确圈定了三种场景；第二，写排除项，`when_to_use` 的价值主要在"Only for X. Y belongs elsewhere instead"，帮模型在相邻工具间分流；第三，别在 description 里写操作步骤——那是正文的职责，目录页只负责让人翻书。

## 技能门：历史即记忆

有一个看似简单的问题：**运行时怎么知道"某个技能已被加载过"？** 比如 5.7 节的工作流工具规定：没加载 `dynamic-workflows` 技能就拒绝执行——否则模型会拿错误的脚本格式来调它。

直觉答案是维护一个 `Set<string>`：加载时 `add`，查询时 `has`。ZCode 的真实实现偏不（`packages/core/src/agent/loaded-skills.ts`）：它**扫描 provider 可见的历史消息**，判断里面是否存在一次成功的 Skill 工具调用——"历史即记忆"。

为什么刻意绕开 Set？回忆 2.4 节的压缩（compact）：压缩会把旧消息摘要化，Skill 工具调用很可能被挤出去。如果用 Set 记录，压缩之后 Set 依旧说"已加载"，但模型**已经不记得**技能正文了——门开着，人却不在。以历史为判据，压缩把 Skill 调用挤出去的那一刻，门就自动重新关上，模型必须重新加载才能通过。状态存储与模型可见性保持同一份事实，这消除了两类记录不同步的整类 bug。

> **注**：这个设计的前提是"消费方检查"与"模型记忆"必须同生共死。如果你的扩展也需要"加载过才能用"语义，直接照抄：**判据取自模型可见的历史，而不是运行时的旁路记录**。

## 自定义命令：参数化的 prompt 模板

Skill 解决"按需加载"，但每次都要模型去"发现"它。有时候你想要更直接的东西：敲一个 `/deploy prod`，一段预先写好的 prompt 模板立刻带着参数进入对话。这就是自定义命令（custom command）——**markdown 文件形式的斜杠命令**。

命令的发现目录与 Skill 完全同构：显式 roots → `~/.zcode/commands` → `~/.agents/commands` → 项目各层的 `.zcode/commands`、`.agents/commands` → 插件 roots。递归扫描（深度上限 12），**子目录拼进命令名**：`review/code.md` 注册为 `/review:code`。当用户敲下一个未命中内置命令的 `/xxx` 时（内置命令如 `/help`、`/compact` 硬编码在 CLI 里），就落到这些 markdown 文件上。

命令文件的格式——frontmatter 白名单字段，正文即模板：

```markdown
---
description: Review the current diff          # 必需；缺省时从正文首段提取
argument-hint: "[pr-number] [--verbose]"      # UI 补全提示，不进 prompt
allowed-tools: Bash(git *), Read              # 本命令内免审批的工具
model: glm-4.7                                # 本命令使用的模型
disable-noninteractive: true                  # headless 模式下禁用
skills: code-review, security                 # 声明依赖的技能
---
请审查 $1 号 PR 的改动，重点关注 $2。
调用 git diff 与相关文件，按安全、性能、可维护性三个维度输出意见。
```

展开逻辑（`packages/cli/src/custom-command-expand.ts`，有删节）处理三类占位：

```ts
const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;

let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
  usedArgumentsPlaceholder = true;
  return positional[Number(index) - 1] ?? "";
});

if (args.length > 0 && !usedArgumentsPlaceholder) {
  body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
}
```

`$ARGUMENTS` 是参数整串，`$1`、`$2` 是位置参数——切分是**引号感知**的，`/deploy "my app" prod` 会正确得到两个参数。用户给了参数但模板里没有任何占位符时，参数自动以 `User arguments:` 段落追加到末尾——参数永不静默丢失。反向的防御也有：Claude Code 的动态 shell 语法（`` !`cmd` `` 与 ```` ```! ```` 围栏）**明确不支持**，检测到直接抛错，而不是把一行 shell 静默留在 prompt 里让模型困惑。

展开后的最终产物不是"执行某个特殊流程"，而是**一条普通用户消息**，外面包上元信息：

```text
Run custom command /review.
Command source: project/review/code.md.
Required skills: `code-review`, `security`.
Before following the command body, call the Skill tool for `code-review`, `security`.

（模板正文，占位符已替换）
```

注意第三、四行：frontmatter 声明的 `skills` 被翻译成对模型的**强制指令**——先调 Skill 工具加载这些技能，再执行正文。

## 命令、Skill 与 Plugin 的边界

命令与 Skill 共享同一套发现目录与优先级规则，本质都是"markdown 进 prompt"，差异只有两点：**注入时机**（命令在用户敲下时立即展开注入；技能由模型按需调用加载）与**参数处理**（命令有 `$ARGUMENTS`/位置参数；技能靠模型在调用工具时自己填 `args`）。由此得出选用经验：**流程固定、参数规整的动作用命令**（`/review`、`/deploy`），**知识密集、时机未知的参考资料用技能**（框架指南、内部规范）。两者还能组合：命令的 `skills:` 字段把技能变成命令的前置依赖，`/skill <name> [task]` 内置命令则提供了手动加载技能的入口。

那 Plugin 呢？它不是与这两者并列的第四种东西，而是**它们的发行形态**：把若干技能、命令加上 hooks、MCP 服务器、子代理配置打包成一个可安装、可分发的单元。命令与 Skill 是"内容"，Plugin 是"包装箱"——下一章专门拆这个箱子。

## 教学版：src/skills.ts

tinycode 的 `src/skills.ts` 实现三件事：扫描目录、解析 frontmatter、构建清单。先看扫描与解析：

```ts
// tinycode/src/skills.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  whenToUse?: string;
  path: string; // SKILL.md 绝对路径
}

// 扫描规则与真实系统一致：目录下的每个子目录是一个候选技能
export async function scanSkills(skillDir: string): Promise<SkillMeta[]> {
  const entries = await readdir(skillDir, { withFileTypes: true });
  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await parseSkillFrontmatter(join(skillDir, entry.name, "SKILL.md"));
    if (meta) skills.push(meta);
  }
  return skills;
}
```

frontmatter 是扁平标量，逐行解析即可，无需引入 YAML 库；`name`/`description` 缺失或 description 超过 1024 字符时按真实系统的语义拒绝：

```ts
async function parseSkillFrontmatter(path: string): Promise<SkillMeta | undefined> {
  if (!(await stat(path).then(() => true).catch(() => false))) return undefined;
  const raw = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replaceAll('"', "");
  }
  if (!fields.name || !fields.description) return undefined;
  if (fields.description.length > 1024) throw new Error(`技能 ${fields.name} 的 description 超过 1024 字符`);
  return {
    name: fields.name,
    description: fields.description,
    whenToUse: fields.when_to_use,
    path,
  };
}
```

然后是清单构建与正文加载，把 20000 字符预算与 100KB 上限这两个常数落在代码里：

```ts
const LISTING_BUDGET = 20_000;
const MAX_SKILL_BYTES = 100_000;

export function buildSkillListing(skills: SkillMeta[]): string {
  const header = "The following skills are available for use with the Skill tool:";
  const lines = skills.map((s) => {
    const desc = s.whenToUse
      ? `${s.description} ${s.whenToUse}`.slice(0, 250)
      : s.description.slice(0, 250);
    return `- ${s.name}: ${desc} (file: ${s.path})`;
  });
  const full = [header, "", ...lines].join("\n");
  if (full.length <= LISTING_BUDGET) return full;
  // 超预算整体降级：丢弃全部描述，只留名称与路径
  const namesOnly = skills.map((s) => `- ${s.name} (file: ${s.path})`);
  return [header, "", ...namesOnly].join("\n");
}
```

正文加载对应 Skill 工具的 handler：剥 frontmatter、截断、展开变量、装进信封：

```ts
export async function loadSkillBody(skill: SkillMeta): Promise<string> {
  const raw = await readFile(skill.path, "utf8");
  const body = raw.replace(/^---\n[\s\S]*?\n---/, "").trim().slice(0, MAX_SKILL_BYTES);
  const baseDir = dirname(skill.path);
  // ${ZCODE_SKILL_DIR} 只在加载时展开：清单阶段不存在"当前技能"
  const expanded = body.replaceAll("${ZCODE_SKILL_DIR}", baseDir);
  return [
    `<skill_content name="${skill.name}">`,
    expanded,
    "",
    `Base directory for this skill: ${baseDir}`,
    "</skill_content>",
  ].join("\n");
}
```

在 `src/loop.ts` 里的接入方式：启动时 `scanSkills` 各技能根目录，`buildSkillListing` 的产物并进系统提示词构建（2.3 节的 `src/context.ts`）；再注册一个名为 `Skill` 的工具（用 2.1 节的 `src/tools/registry.ts`），handler 就一行 `loadSkillBody`。教学版省略了多根目录优先级合并、symlink 检查与技能门——技能门照抄很简单：查历史消息里有没有 `name === "Skill"` 的成功工具调用即可。

## 小结

Skill 用渐进披露化解"指令多、上下文小"的矛盾：一份不超过 20000 字符的元数据清单常驻上下文，每条描述截断到 250 字符，正文（上限 100KB）由模型按需通过 Skill 工具加载，`${ZCODE_SKILL_DIR}` 延迟到加载时才展开。description 就是触发条件，值得像写检索关键词一样打磨。技能门以"历史即记忆"的判据与压缩机制保持一致。自定义命令复用同一套发现目录，把技能体系参数化成 `/xxx` 入口，与技能的差异只在注入时机与参数处理。

目前所有扩展都长在用户与项目的配置目录里，无法整包分发。下一章讲 Plugin：把技能、命令、hooks、MCP 服务器装进一个清单文件，配上市场机制，让扩展可以一键安装。
