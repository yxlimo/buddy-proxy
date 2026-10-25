# pi 项目配置

本项目里的 skill（`hello_js_reverse_skill`）放在 `.agents/skills/`，OpenCode 与 pi 都能读到；
pi 侧再配一个 agent 定义，让它只出现在 subagent 的提示里。

## skill 放哪

`.agents/skills/hello_js_reverse_skill/` 是唯一一份技能正文。两个客户端都读这个位置：

| 宿主 | 依据 |
| --- | --- |
| OpenCode | 项目 agent 兼容目录 `.agents/skills/<name>/SKILL.md`（从当前目录往 git 根走） |
| pi | 项目 agent 兼容目录 `<cwd>/.agents/skills/<name>/SKILL.md`（要项目被信任） |
| pi-subagents | 子代理按名字解析技能时扫 `<cwd>/.agents/skills` |

不需要软链。

## 组成

| 路径 | 作用 |
| --- | --- |
| `.agents/skills/hello_js_reverse_skill/` | 技能正文。frontmatter 里带 `subagent-only: true`。 |
| `.pi/agents/js-reverse.md` | pi-subagents 的 agent 定义：`inheritSkills: false` + `skills: hello_js_reverse_skill` + `skillPath: ../../.agents/skills`，所以只有这个 subagent 的提示里带该技能。 |
| `.pi/check-subagent-only-skill.mjs` | 不调模型的回归检查（见下）。 |

主 agent 那一侧的过滤不在本仓库：扩展装在用户目录里——

```
~/extensions/subagent-only-skills/          # 独立仓库，有自己的 HANDOFF.md
  └─ packages/pi-plugin/src/index.ts        # before_agent_start 里剔除带标记的 skill
~/.pi/agent/extensions/pi-subagent-only-skills -> 上面那个包目录（软链）
```

它按 skill 文件自己的 `subagent-only: true` 标记决定隐藏谁，所以是全局扩展，但只影响带标记的
技能。

## 为什么不靠 SKILL.md 的 `disable-model-invocation`

pi 与 pi-subagents 都按这个字段过滤：`disable-model-invocation: true` 会让 pi-subagents 的
`buildSkillInjection` 把它一起剔掉，subagent 也就拿不到了。要「主 agent 不可见、subagent
可用」，只能在主 agent 那一侧拦，也就是扩展改提示词选项。

pi 的 skill 列表进提示词的路径：`loadSkills` → `systemPromptOptions.skills` →
`buildSystemPromptSections` → `formatSkillsForPrompt`。扩展在 `before_agent_start` 里改的是
同一个对象（pi 的 ExtensionRunner 把同一个 `currentOptions` 传给所有 handler），所以改动直接
反映到本轮提示词。

## 边界

- 子代理拿技能靠 pi-subagents 把技能注入子代理提示词文本；子代理的 pi 级 skill 目录是关掉的
  （`noSkills: !inheritSkills`），扩展在子代理里是空操作。
- 想让别的 subagent 也用这个技能：在对应 agent 定义里加 `skills: hello_js_reverse_skill`
  （+ `skillPath`），或在调用 subagent 工具时传 `skill: hello_js_reverse_skill`。
- 人工仍可显式加载：`/skill:hello_js_reverse_skill`。
- 扩展是全局的：所有 pi 项目都加载它，是否隐藏看每个 skill 自己的标记。

## 校验

```bash
node .pi/check-subagent-only-skill.mjs
```

覆盖：pi 启动时发现 skill、加载扩展、扩展剔除它、pi 渲染后的提示词不含它、pi-subagents 发现
`js-reverse` agent 并按 `skills` + `skillPath` 解析到同一个技能、技能进入子代理提示词。

本机没有 pi / pi-subagents / 扩展安装时脚本直接跳过。
