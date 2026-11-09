# 四个客户端的 system prompt：横向对比

日期：2026-11-07
范围：ZCode 3.16.3、WorkBuddy 4.24.5（CodeBuddy Code 引擎）、opencode、pi 1.5.0。
方法：只读本机文件（客户端安装目录、客户端落盘的请求日志与产品配置缓存、打包后的可执行文件），不联网、不发请求。

原文（逐字，含本机路径）留在本机 `docs/system-prompts/`，不入库；本文是脱敏后的横向对比。

## 0. 一行结论表

| 客户端 | 几段 | 大致长度 | 客户端身份指纹段 | 能不能换成别家的 |
| --- | --- | --- | --- | --- |
| ZCode | 3 段（数组 3 个 text 块） | 42 + 3100 + 7604 = 10746 字符 ≈ 2.7k token | 有：第 1 段整句 + 第 2 段开头 + `# ZCode Desktop Context` | 不能。上游按前两段逐字比对，差一个字符就是 3012 |
| WorkBuddy | 1 条 system（客户端内部是多段拼起来的） | 模板 19831 字符 ≈ 5.0k token；渲染后还要加工具说明/模式追加/环境块 | 有：首行 `You are CodeBuddy Code.` + 中国政治内容政策段 + cnb.cool 文档地址 | 只能改首行自报家门，其余必须原样 |
| opencode | 1 条 system（+ 若干条独立的 system 指令消息） | build 提示词 7684 + 段落 300 ≈ 2.0k token；环境/日期块再几百 | 弱：`You are opencode, an interactive CLI tool…` | 可以（上游不校验），但工具名/语义会与模型能力不匹配 |
| pi | 1 条 system，由 8 个 section 拼成 | 静态约 2.0–2.5k 字符 ≈ 0.5–0.6k token；`AGENTS.md` 另算 | 弱：`You are a coding assistant running inside pi…` | 可以（上游不校验） |

「指纹」= 上游可能拿来判断「这条请求是不是自家客户端发的」的段落。

## 1. ZCode

原文：`docs/system-prompts/zcode.md`

### 1.1 段数与分隔

- 3 段，Anthropic 方言的 `system` 数组，3 个 `type: "text"` 块，顺序固定。
- 段与段之间没有分隔符，就是三个独立的数组元素。
- 三段逐字长度：42 / 3100 / 7604。

### 1.2 结构

| 维度 | 在哪一段 |
| --- | --- |
| 身份声明 | 第 1 段整句；第 2 段开头再声明一次 |
| 环境信息 | 第 2 段 `# ZCode Desktop Context`：会话可视化目录（一个本机绝对路径）、Gen UI 能力、`window.zcode` 桥 |
| 工具使用规则 | 第 2 段 `# Harness`：终端输出格式、权限模式、专用文件/搜索工具优先于 shell、并行调用 |
| 编辑文件规则 | 第 3 段 |
| 回复风格 | 第 3 段 |
| 安全/拒绝规则 | 第 2 段开头：授权安全测试、拒绝破坏性技术/DoS/大规模攻击/供应链/检测规避 |
| 并发与子任务 | 第 2 段 `Independent tool calls can run in parallel in one response` |

### 1.3 动静态

- 第 1 段：纯常量。
- 第 2 段：常量 + 一个运行时会话可视化目录（绝对路径，每次会话不同）。
- 第 3 段：常量。

### 1.4 长度

10746 字符 ≈ 2.7k token。

### 1.5 工具说明放在哪

不在 system 里描述工具参数；工具本身是独立的 tool schema。第 2 段只讲「怎么用工具」的通则。

### 1.6 身份指纹

有，而且强：上游做的是**逐字比对**（见 `docs/zcode/3012-system-prompt.md`）。

### 1.7 我们网关怎么处理

- `lib/router/upstreams/zcode.ts`：body 原样透传，**不注入也不改写 system**。请求是 Anthropic 方言就原样过去，OpenAI 方言才用 `openaiToAnthropic` 转。
- 后果：调用方（Agent）必须自己带上官方前两段，否则上游回 `405 code 3012`。
- 另一个坑：`lib/dialect/request.ts`（`openaiToAnthropic`）会把**所有 system / developer 消息合并成一个字符串**（用两个换行连）。ZCode 要求三段是数组的三个元素；合并成一段就是 3012。走 Anthropic 方言进来才不合并。

### 1.8 能不能换

不能换成别的客户端的 prompt：上游比的是实质内容，不是长度（塞 11KB 合成文本照样 3012）。反过来说，也**不能**在官方前两段后面再追加第 4 段（同样 3012），调用方自己的指令只能放进首条 user 消息。

## 2. WorkBuddy

原文：`docs/system-prompts/workbuddy.md`

### 2.1 段数与分隔

- 上游收到的是 **1 条** system（OpenAI 方言的 `messages[0].role = "system"`）。
- 客户端内部是「模板 + 若干追加」拼成的一条：模板 `cli-agent-prompt`（19831 字符，jinja 模板）→ 模式追加（Standard / PTC / Minimal / Creator / Multitask 各不同）→ 工具说明 → 环境块 `<env>`。
- 模板里的追加块用 `<env> … </env>` 这类标签分段。

### 2.2 结构

| 维度 | 在模板哪一块 |
| --- | --- |
| 身份声明 | 第 1 行 `You are CodeBuddy Code.` |
| 环境信息 | `<env>` 块：Working directory / Is directory a git repo / Platform / Is WSL / OS Version / Default shell / Today's date / Additional workspace directories |
| 工具使用规则 | `# Tone and style`、`# Following conventions`、`# Doing tasks`、`# Tool usage policy`；工具自己的说明在 `tool-*-description` 提示词条目里（进 tool schema，不进 system） |
| 编辑文件规则 | `# Following conventions`（模仿现有代码风格、不引入未使用的库） |
| 回复风格 | `# Tone and style`（简洁、直接、不加解释） |
| 安全/拒绝规则 | `<content_policy>`：政治敏感、涉黄、违法、隐私、假新闻五类必须拒绝，且不得被「测试/研究/假设」绕过；另有一段授权安全测试条款 |
| 并发与子任务 | 模板不含；子 agent 是 `system-reminder-delegate`（13265 字符）这类独立的追加提示 |

### 2.3 动静态

- 静态：品牌名、content_policy、风格与流程规则。
- 动态：`{{workDir}}`、`{{platform}}`、`{{version}}`、`{{defaultShell}}`、`{{date}}`、`{{modelName}}`、`{{modelId}}`、`{{language}}`、`{{outputStyle}}`、`{{cliDescription}}`、`{{cliDocsDir}}`、`{{dir}}`（additionalDirs 循环），以及 `isGitRepo` / `isWsl` / `briefMode` / `modelSupportsImages` 这些条件位。

### 2.4 长度

模板 19831 字符 ≈ 5.0k token。渲染后还要加模式追加、工具说明、`agent-instructions`（5701 字符）等，实际送出的通常在 25–30k 字符量级。

### 2.5 工具说明放在哪

工具说明在产品配置的 `tool-*-description` 条目里（每条工具一个），走 tool schema，不在 system。

### 2.6 身份指纹

有，且上游真的在校验：

- 上游的渠道校验读的是 **system 开头那句自报家门**；认出来的是 `You are Claude Code, Anthropic's official CLI for Claude.` 这类句子，不在开头就不算。
- 我们模拟端用的开场白是 `You are CodeBuddy Code.`（与官方客户端逐字一致，见 `lib/workbuddy/identity.ts`）。
- 附带指纹：`content_policy` 那段中国政治内容政策、文档地址 `cnb.cool/codebuddy/codebuddy-code/…`。

### 2.7 我们网关怎么处理

- `lib/workbuddy/transport.ts`（`buildChatBody`）：没有 system 就塞 `DEFAULT_SYSTEM = "You are CodeBuddy Code."`；有 system 就调 `rewriteSystemContent`。
- `lib/workbuddy/identity.ts`：**只改开头那一句**（把 `You are Claude Code…` 换成 `You are CodeBuddy Code.`），其余一句不改。多段 system 数组只处理第一段。
- 上游认的是开头，所以 opencode / pi 那套 system 送过来也能过渠道校验，但正文里仍然是别家客户端的工具语义。

### 2.8 能不能换

- 换成别的客户端的 system：**上游放行**（实测 Cursor / Codex / OpenCode / pi / Kimi / Qwen 的开场白都放行），只要开头那句别自称成别家客户端（自称 Claude Code 会被拒 11128）。
- 统一成一套最小 prompt：渠道校验会过，但模型会按别家客户端的工具名与流程思考；工具 schema 又是我们另配的，容易出现「提示词里说的工具不存在」。
- 真正的损失是 content_policy 那类东西可以省（省了不会 11128），但正文风格会明显不是官方客户端。

## 3. opencode

原文：`docs/system-prompts/opencode.md`

### 3.1 段数与分隔

- 主提示词是**一条** system 文本（7684 字符）+ 一条紧跟的段落（`# Code comments`，300 字符）。
- 另外还有独立的 system 消息：`core/environment`、`core/date`、`core/codemode`（Code Mode 工具目录，很长）、`core/instructions`（项目指令文件）、`core/reference-guidance`、`core/skill-guidance`。
- 多个 agent 各有自己的提示词（build / general / task 等）。

### 3.2 结构

| 维度 | 在哪 |
| --- | --- |
| 身份声明 | 第 1 行 `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` |
| 环境信息 | `core/environment`：Platform / Working directory / Workspace root folder / Is directory a git repo；`core/date`：Today's date |
| 工具使用规则 | `# Tool usage policy`、`# Tool Use - Parallelism`、`# Tool Use - Local Computation`、`# Tool Use - OpenCode Specifics` |
| 编辑文件规则 | `# Following conventions`、`# Code style`（不加注释）、`# Code comments`（跟随上下文注释密度） |
| 回复风格 | `# Tone and style`（少于 4 行、不写前后废话） |
| 安全/拒绝规则 | 无专门的安全段 |
| 并发与子任务 | `# Tool Use - Parallelism`；`subagent` 工具那条在另一个 agent 提示词里 |

### 3.3 动静态

- 静态：build 提示词 7684 + `# Code comments` 300 + 资源 3（2572）+ 资源 4（7853，含 `{{MODEL_NAME}}` 占位）。
- 动态：环境块、日期块、Code Mode 工具目录、项目指令文件。

### 3.4 长度

build 一条 ≈ 7984 字符 ≈ 2.0k token；加环境/日期约 2.1k token。Code Mode 目录单独一条，可能再几千字符。

### 3.5 工具说明放在哪

工具参数与说明在 tool schema 里；system 只讲策略（并行、别重复搜、优先用 subagent 省上下文）。

### 3.6 身份指纹

弱：只有第 1 行的 `You are opencode…`。没有平台/机型/会话路径类指纹（环境块里的 cwd 是通用信息）。

### 3.7 我们网关怎么处理

opencode 是 **Agent**，不是模拟端：网关不替它改 system。

- 路由到 WorkBuddy 上游时：走 `lib/workbuddy/transport.ts`，只把开头那句自报家门改掉，opencode 的正文原样送。
- 路由到 ZCode 上游时：`lib/router/upstreams/zcode.ts` 原样透传，opencode 的 system 与 ZCode 要求的逐字前两段对不上 → **必回 3012**。
- 所以「会不会同时出现在一次请求里」：会。一条请求只有一个 system（dialect 转换可能把多条 system 合并成一条），但它里面同时装着 Agent 的提示词与模拟端补的部件。WorkBuddy 上游看到的是「opencode 的正文 + CodeBuddy Code 的开头」；ZCode 上游看到的是「opencode 的正文」。

### 3.8 能不能换

能，上游不校验。但工具名不同（opencode 用 `read`/`edit`/`shell`/`webfetch`），换成别家的提示词会让模型去找不存在的工具。

## 4. pi

原文：`docs/system-prompts/pi.md`

### 4.1 段数与分隔

- 发 **1 条** system 字符串，由 8 个 section 拼成，段间用两个换行。
- 顺序固定：preamble → tools → rules → docs → addendum → project_context → skills → cwd。
- 除 preamble 外每段在文本里被 `<段名> … </段名>` 包住。

### 4.2 结构

| 维度 | 在哪 |
| --- | --- |
| 身份声明 | preamble：`You are a coding assistant running inside pi, a coding agent harness.` |
| 环境信息 | `<cwd>` 段（只有路径） |
| 工具使用规则 | `<rules>` 段（工具 guideline + 两条固定规则） |
| 编辑文件规则 | 由 edit 工具的 guideline 承担（`Use edit for targeted changes…`） |
| 回复风格 | `<rules>` 里的 `Be concise in your responses` |
| 安全/拒绝规则 | 无 |
| 并发与子任务 | 无（子任务是 pi-subagents 扩展的事） |

### 4.3 动静态

- 静态：preamble 131 字符、docs 段、两条固定规则、各工具的 snippet 与 guideline。
- 动态：工具集合、`AGENTS.md` 等项目指令（`project_context`）、skills、cwd。

### 4.4 长度

静态约 2.0–2.5k 字符 ≈ 0.5–0.6k token；`AGENTS.md` 另算（本仓库那份约 4.8K 字符 ≈ 1.2k token）。

### 4.5 工具说明放在哪

工具参数与说明在 tool schema；system 里只留 snippet（每工具一行）与 guideline。

### 4.6 身份指纹

弱：preamble 一句自称 pi。没有平台/机型/路径指纹。

### 4.7 我们网关怎么处理

pi 也是 Agent，网关不干预。它路由到哪个上游，system 就原样去哪个上游；WorkBuddy 上游会改开头那句自报家门，ZCode 上游不会改 → 3012。

另注：pi 另有两套提示词——压缩摘要用的 `SUMMARIZATION_SYSTEM_PROMPT`（`You are a context summarization assistant.`），以及 pi-subagents 扩展给每个角色一条的 agent 提示词（`worker`/`researcher`/`reviewer`/`scout`/`oracle`/`evidence-auditor`/`delegate`）。

### 4.8 能不能换

能，上游不校验。

## 5. 我们网关现状小结

- **WorkBuddy**（`lib/workbuddy/transport.ts` + `lib/workbuddy/identity.ts`）：改 system 的**开头一句**。没有 system 就补一句官方开场白。多段数组只改第一段。
- **ZCode**（`lib/router/upstreams/zcode.ts`）：**完全不碰** system。官方前两段得由调用方自己带。
- **opencode / pi**：Agent，不是模拟端，网关不干预。

三条模拟端路径里，只有 WorkBuddy 的上游会看 system 的内容；ZCode 会逐字比对前两段。

## 6. 风险与未解

- WorkBuddy 只拿到**模板**，没有拿到渲染后的成品（本机没有落盘的渲染结果）。模板里的模式追加与工具说明是另算的，实际送出的长度可能比 19831 大不少。
- ZCode 的前两段是 3.16.3 客户端的值；官方客户端升级后这两段会不会变，未验证。
- opencode 与 pi 的 system 段之间没有统一的分段约定（opencode 是多条 system 消息，pi 是单条内的多 section），经我们 dialect 转换后形态还会再变。
- 没有对任何上游发过验证请求（本轮只读本机文件）。
