# pi 项目配置

本目录让 pi 在本项目启动时加载 `hello_js_reverse_skill`，但主 agent 看不到它，只有 subagent 能调用。

## 组成

| 路径 | 作用 |
| --- | --- |
| `skills/hello_js_reverse_skill` | 指向 `../../.opencode/skills/hello_js_reverse_skill` 的符号链接。pi 启动时在项目 skills 目录发现它并注册；技能正文仍只有 `.opencode/skills/` 一份。 |
| `extensions/subagent-only-skills.ts` | 在 `before_agent_start` 里把这些 skill 从 `systemPromptOptions.skills` 剔除，主 agent 的系统提示里就没有对应条目。 |
| `agents/js-reverse.md` | pi-subagents 的 agent 定义：`inheritSkills: false` + `skills: hello_js_reverse_skill` + `skillPath: ../../.opencode/skills`，所以只有这个 subagent 的提示里带该技能。 |
| `check-subagent-only-skill.mjs` | 不调模型的回归检查（见下）。 |

## 为什么不靠 SKILL.md 的 `disable-model-invocation`

pi 与 pi-subagents 都按这个字段过滤：`disable-model-invocation: true` 会让 pi-subagents 的 `buildSkillInjection` 把它一起剔掉，subagent 也就拿不到。要「主 agent 不可见、subagent 可用」，只能在主 agent 那一侧拦，也就是扩展改提示词选项。

pi 的 skill 列表进提示词的路径：`loadSkills` → `systemPromptOptions.skills` → `buildSystemPromptSections` → `formatSkillsForPrompt`。扩展在 `before_agent_start` 里改的是同一个对象（pi 的 ExtensionRunner 把同一个 `currentOptions` 传给所有 handler），所以改动会直接反映到本轮提示词。

## 边界

- 子代理拿技能靠 pi-subagents 把技能注入子代理提示词文本；子代理的 pi 级 skill 目录是关掉的（`noSkills: !inheritSkills`），扩展在子代理里是空操作。
- 想让别的 subagent 也用这个技能：在对应 agent 定义里加 `skills: hello_js_reverse_skill`（+ `skillPath`），或在调用 subagent 工具时传 `skill: hello_js_reverse_skill`。
- 人工仍可显式加载：`/skill:hello_js_reverse_skill`。
- 反过来，扩展对所有会话生效：把新技能加进扩展里的 `SUBAGENT_ONLY_SKILLS` 即可。

## 校验

```bash
node .pi/check-subagent-only-skill.mjs
```

覆盖：pi 启动时发现 skill、扩展剔除它、pi 渲染后的提示词不含它、pi-subagents 发现 `js-reverse` agent 并按 `skills` + `skillPath` 解析到同一个技能、技能进入子代理提示词。

本机没有 pi 安装时脚本直接跳过。
