# 交接文档

这个项目是什么、怎么跑起来、哪里有坑。给接手的人或 agent 看。

[README](README.md) 说各个部件是什么。这份说整体怎么搭在一起，以及哪些地方会咬人。

## 是什么

一个反向代理：把几个免费的模型提供方收在一个端口后面，OpenAI 和 Anthropic 两种方言都能答。

| | |
|---|---|
| 进程 | 一个：`router-proxy.ts`，端口 6450 |
| 面板 | 同一个端口，`/admin` |
| 契约 | protobuf + Connect，在 `proto/buddy/admin/v1/admin.proto` |
| 凭据 | SQLite（`node:sqlite`，没有额外依赖）|
| 运行时 | Node 24，代码走类型剥离，没有构建步骤 |
| 前端 | React + Vite + shadcn/ui + Connect，在 `web/` |

背后有九个上游，每个一个开关，**默认全关**：MiniMax Code、MiniMax 开放平台、Qoder（两个区域，所以两个开关）、WorkBuddy 中国区、TokenRhythm、ZCode、SenseNova、书生·端砚。

## 术语

`AGENTS.md` 里定好了，代码和文档都按那套说：**agent** 是调网关的一方，**模拟端**是网关对上游做的那件事——把请求指纹对齐上游的封闭客户端，并让那个客户端的会话保持活跃。这里不重复。

## 跑在哪

**正式环境只有一个实例：NAS 上那个容器。** 本地这份是源码副本。

这样布置唯一的真风险：MiniMax 和 Qoder 的 refresh token **每次刷新都轮换**，所以同一份会话不能由两个地方轮流刷新。**本地副本和 NAS 上不能同时持有同一个账号的会话。** `lib/session.ts` 在刷新时加了锁——那只管一台机器，管不了两台。

所有东西在一个目录里——`BUDDY_DATA_DIR`，NAS 上是 `/data`：

```
/data/buddy.db        数据库：凭据、设置、缓存、锁
/data/auth.log        凭据日志（容器重建也留着）
/data/identity.salt   账号指纹的盐
/data/*.json          旧的凭据文件，只读一次作兜底
```

`docker logs` 撑不过容器重建，所以凡是跟凭据有关的事都写 `auth.log`（`lib/credential.ts` 的 `authLog`）。

**本地可以再起一个实例**，前提是它用**自己的** `BUDDY_DATA_DIR`（`/home/shay/.buddy-proxy-zcode` 那种），而且**不持有 NAS 上那些账号的会话**。这是 ZCode 实验的现状：桌面端持有会话并自己续期，本地网关用定时同步脚本跟着搬，令牌从不两边同时用。

反过来，**不要拿生产库的副本在本机起第二个网关实例**——它一刷新，线上那份就作废（2026-10-25 那次事故就是这么发生的）。

## 设置

三个来源，**环境变量优先**：

1. 环境变量——部署时设的（含 `.env`）
2. 数据库——面板写的
3. 代码里的默认值

**环境变量钉住的设置，面板改不动它**（但面板写的那份留在库里，环境变量撤了就轮到它）。面板同时显示两个：现在生效的那个，和它写下去等着的那个；保存时会说清楚「写了，但被环境变量钉着」。

大部分设置在启动时读一次。有几个是**热的**，每个请求都重读：前门的 key 校验、用量保留天数。面板只能改热的那些和前门；其余是服务自己的事（那些用 `config-cli.ts`）。

**上游的开关不在设置里**——它是数据库里 `provider` 表的一行（`enabled` 那一列）。面板的「上游」页改它，下一个请求就是新的。环境变量里曾经有过九个开关，已经删了：那套只在新装时当初值，行存在之后再也不被读，两处会打架。

**凭据不走这套**：凭据只在**账号自己名下**（`session:provider:<账号>`、`key:provider:<账号>:<用途>`），环境变量不是凭据来源（它以前是，而且每读一次就把自己写回数据库——于是删掉的账号转眼又有了身份）。

## 面板

- 地址：同一个端口上的 `/admin`
- 令牌：`/data/admin-token`，0600，第一次启动时生成并**只那一次**打进日志。面板再也不显示它——自己从文件里扒。
- 面板是给它所在的那个网络用的。它手里握着凭据，从外面访问要走 HTTPS 或者 Tailscale。

上游都在一页里：每行展开就是它的账号（provider）和凭据。有可用凭据的账号给的是**注销**按钮而不是登录；注销删掉凭据，账号回到「没有凭据」。

## 路由

两条进法：

| | |
|---|---|
| 按路径 | `/{上游 id}/v1`——那里的模型名是真名 |
| 按模型名 | 根 `/v1`——模型名带前缀 |

根路由只服务**面板发布出来的模型**；库里没有发布模型就回 404。发布出来的模型 = 名字 + 策略 + 一个或多个目标（`{上游 id}/{上游模型}`），它对外报的参数是**从目标算出来的**——上下文取最小、输出上限取最小、思考档位取交集。

主路由接的是**上游**，不是账号；上游内部自己的策略（几个 provider 谁先上）跟主路由的策略互相独立，两层一起生效。

两种方言哪儿都能用。答复跟着来——agent 用哪种方言问，就用哪种方言答，两边 `model` 字段都是发布出来的那个名字。

## 方言层

`lib/dialect/` 负责两种方言互转，两个方向都覆盖：请求、流式答案、整体答案。思考块在 OpenAI 侧是 `reasoning_content`，在 Anthropic 侧是 `thinking` 块——**绝不混进正文**。

## 用量日志

每个真正打到上游的请求一行：什么时候、哪个上游、哪个模型、哪个 agent 发的、哪个会话、哪个主会话、哪个子代理、成没成、用了多少 token。

**主会话是那条链的根**：子代理的流量并进主代理的会话；子代理还能再派子代理，所以要一路往上溯。会话那一栏只列用得最多的十个。

超过 `USAGE_RETENTION_DAYS`（默认 30 天）的行在启动时清一次，运行中每小时清一次。

## 测试

全部离线：打假上游，或者打录下来的 fixture。**任何测试都不花钱**——这是硬规矩，因为真上游要花积分，而额度很小。

```bash
mise run test              # 整个矩阵
mise run test:admin        # 单独一块
mise run test:route        # 路由的端到端
```

`mise.toml` 里列了全部。新开一块就加一个 task。

**需要真凭据的测试写不了** —— 假的凭据会被平台拒，所以两边都是 null。那种测试要断**形状**（键在哪、怎么查）而不是值，真东西到 NAS 上验。

## 部署

**没有指令不要部署。** 规矩是：改动提交在本地，等操作者发话，一次集中上。除了服务挂了——那种立刻上。

```bash
tools/deploy-nas.sh       # 构建镜像、送过去、换容器
```

`tools/` 是这一台机器的脚本，不进仓库（`tools/deploy-nas.sh`、`tools/patch-clients.py`、`tools/opencode-webui-models.py`）。

部署**不先停服务** —— 换容器时旧的收到 SIGTERM，不再接新请求，把手上那批干完才走。凭据迁移在服务运行时做 —— 两份里取 generation 高的那个，中间撞上一次刷新只会让库里多一代。

客户端配置（opencode、pi）由 `tools/patch-clients.py` 写 —— 它自己从网关拉模型清单。**部署完再跑**，不是之前。

## 本机的 agent 配置

跟网关代码无关，但同仓库：项目里带一个 pi-subagents 的 agent，让逆向类任务交给子代理，主 agent
不揽。

| | |
|---|---|
| 技能正文 | `.agents/skills/hello-js-reverse-skill/`——OpenCode 与 pi 都读这个位置，一份就够，不用软链 |
| agent 定义 | `.pi/agents/js-reverse.md`——`inheritSkills: false` + `skills:` + `skillPath:` |
| 过滤扩展 | `~/extensions/subagent-only-skills/`（独立仓库，软链到 `~/.pi/agent/extensions/`） |
| 检查 | `node .pi/check-subagent-only-skill.mjs`（不调模型） |

技能在 frontmatter 里声明 `subagent-only: true`，扩展据此把它从**主** agent 的系统提示里拿掉，
子代理照旧能拿到（pi-subagents 把技能注入子代理的提示词文本）。

**不能改用 `disable-model-invocation`**：pi-subagents 也按那个字段过滤，子代理会跟着一起丢，
两头都没了。

扩展仓库在 `~/extensions/`，有自己的 README 与 HANDOFF。

## 定时器

`lib/periodic.ts`：**一个定时器**（默认一分钟一跳），每跳按顺序做四件事：

1. 到期了就刷令牌（只在临期窗口里刷，不是因为某次请求失败了）
2. 到点了就签到
3. 到点了就扫余额
4. 按余额排序重新钉住「余额到期优先」那个账号

**每份登录态各自独立**：几百个账号可以一起跑，彼此不等、不互锁。

**只有一个刷新者。** 请求路径不刷令牌（读到的是已保存的会话），面板的「试一下」也只读不刷。同一份会话被刷两次，平台会当成重放，把整个会话的令牌一起撤掉。

`PERIODIC_ENABLED=false` 把整个定时器关掉：不换令牌、不签到、不扫余额。调试、复现、离线测试的时候用它——宁可让令牌过期，也不要它自己动。

## 会咬人的地方

找起来费过时间的，下次还会费：

- **refresh token 每次刷新都轮换。** 一份会话，一个持有者。会话的第二个副本就是一份坏掉的会话。
- **定时器写在循环里就等于写了 N 份。** `startPeriodic()` 曾经在遍历 MiniMax 账号的循环体内：有两个账号就起了两个定时器（同时刷同一个会话），一个账号都没有就干脆不起。定时器只有一个，循环在外面。
- **一个模块 import 另一个模块时可能成环。** `lib/platforms.ts` 有一句 `import "./kinds.ts"`（注册各平台），而 `lib/kinds.ts` 引 `lib/zcode/transport.ts`，后者引 `lib/zcode/auth.ts`，后者引 `lib/providers.ts`——回到 `platforms.ts`。结果：单独 import `lib/zcode/auth.ts` 就崩（`ZCODE_BASE` before initialization）。凭据 id 的算法因此搬到了叶子模块 `lib/credential-ids.ts`。**写完一个模块就单独 import 它试一下**，能早发现。
- **“不知道”不能写成“过期”。** ZCode 的 JWT 没有 `exp`，客户端也不记到期时间。把它当成 0（= 不知道）会让一份好好在用的会话被判死。
- **health 快照是按上游 id 存的**，不是按 kind。按 kind 取会静悄悄地全是 null。读它只有一条路：`lib/admin/upstreams.ts` 的 `snapshotEntry`。
- **数据库之前留下的会话文件只属于内置的那一行。** 给别的 id 读它，等于把同一个账号（和同一份 refresh token）交给那个上游。
- **平台的时间戳可能是秒。** ZCode 的登录窗口被当成毫秒读，窗口的终点落到了 1970 年，于是每次登录都超时。
- **凭据的告警意思是「令牌没了，刷新没成功」。** 令牌只是快到期是正常的，刷新会处理。告警线以前比刷新线宽，所以面板每小时叫一次。
- **keep-alive 的竞态。** 服务端 5 秒关掉空闲连接，agent 最多留 6 秒，落在这中间的请求写进了一个已经关掉的 socket。服务端的 `keepAliveTimeout` 现在是 30 秒。
- **凭据那一行、模型对外的参数、发布模型的元数据，是三样不同的东西。** 第一是给人看的视图，第二是告诉客户端的，第三是网关算出来的。别弄混。
- **上游自己的答复不是模拟端的对齐目标。** Qoder 的 CLI 发的和 Qoder 网关收的是两个形状；调研材料在 `docs/`（不进仓库）。
- **上游的错误正文会丢。** 我们把上游非 2xx 的正文放在 error 的 hint 里，而日志与用量表只存 message。排查上游行为时先把它记进日志，否则只能看到状态码。

## 调研材料

`docs/` 在本机，不进版本库（`.gitignore`）：

| | |
|---|---|
| `docs/token-rhythm/` | TokenRhythm 平台、多租户方案 |
| `docs/qoder/` | Qoder 的封闭客户端、活动、机器身份 |
| `docs/workbuddy/` | WorkBuddy 的封闭客户端，以及我们跟它的差异 |
| `docs/minimax/` | MiniMax 的封闭客户端、签到 |
| `docs/sensenova/` | SenseNova 的积分池 |
| `docs/zcode/` | ZCode 的协议调研（`FINDINGS.md` 结论与出处，`DIVERGENCES.md` 实现清单，`405.md` 上游 405 的排查记录）|
| `docs/intern-ai/` | 书生·端砚 |
| `docs/admin-panel/` | 面板的计划 |
| `docs/tasks/<任务>/context.md` | 每个任务的背景、决定与交付记录 |
| `docs/agent-specs/` | 子代理的角色边界（`roles.md`）与协作经验（`collaboration.md`）|
| `docs/bugs/` | bug 报告 |

官方客户端的源码 clone 在 `~/oss/<name>`（ZCode 是 `~/oss/zcode`，v3.16.2）。**不进仓库**，只在本机，用来核对协议。

`reference/qoder/` 是抠出来的 Qoder 封闭客户端材料（同样在本地）。

## 契约

`proto/buddy/admin/v1/admin.proto` 是面板和网关之间**唯一的接缝**。两边用同一份生成物（`lib/gen/`，拷到 `web/.gen/`）。

```bash
mise run proto            # 改完契约重新生成
mise run proto:lint
mise run proto:breaking   # 防破坏性改动的守卫
```

面板能"不填"的字段在 proto3 里是 `optional`——普通字段加一个 presence 位——生成物用 `hasX()` 区分「没设」和「设成了默认值」。"继承上游"那几个开关要的就是这个。

## 风格

- 冷静、只讲事实。不要填充词、不要感叹号、不要「其实」「基本上」「当然」。
- 注释讲**为什么**，不讲这行在干什么。重复代码的注释是噪音。
- 代码和面板里的中文是给操作者看的；README 和提交信息用英文。
- 句子末尾不加符号。真正做完的事打一个，不打两个。
- 找到一个 bug 的时候，把导致它的那条链写下来——文件和行号都写上——然后问一句：**早一点加日志能不能看出来？** 答案通常是「加一行日志」。
