# HANDOVER — WorkBuddy 目录持久化 + fallback 冷却 + 面板/后端语义统一

日期：2026-10-27
状态：**代码已写完并本地提交（未部署、未推送）**。三件事都已实现；等 minimax 额度恢复（`minimax` general 窗口 15:00 结束、`minimax-2` 16:15 结束）后部署验证。

---

## 0. 一句话

三件事：
1. WorkBuddy 模型目录落 DB，写死快照降级为「全新库引导值」（**已实现，已提交**）
2. fallback 冷却：限流/额度用「窗口结束时间 + 1 分钟」，不可用用固定 5 分钟（**已实现，已提交**）
3. 面板与后端语义统一：`video` 窗口后端无视、前端撤掉（**已实现，已提交**）

---

## 1. 为什么做这些

### 1.1 目录（任务 A）

现象：部署后第一次请求 `POST /v1/messages model=workbuddy-deepseek` 回 404
`unknown model "workbuddy-deepseek"`，过一会儿自己好了。

原因链：
- WorkBuddy 的模型 id 来自上游 `GET /v3/config`（缓存 48 分钟），抓不到时回落到
  `lib/workbuddy/models.ts` 的写死常量 `WORKBUDDY_CN_MODELS`
- 那份常量是 **2026-10-21 手抄的快照**，不是上游的运行时缓存：里面没有上游后来
  新增的 `deepseek-v4-flash`
- 进程刚起、还没抓到实时目录时，`modelsOfPlatform("workbuddy-cn")` 用快照
- `lib/router/catalog.ts` 的 `aggregateCatalog` 会把「上游目录里找不到的
  `upstreamModel`」的 target 丢掉 → 已配置的模型在根路由凭空消失 → 404

### 1.2 冷却（任务 B）

现象：`minimax`（Token Plan）的 429 会让每次请求都先打它一次再换号。

根因（已修，`74f395d` 已部署）：`!r.ok` 原先在 `underPolicy` 外面判断，策略看不
见 Response，429 从来没触发过降级。修完后日志能看到
`account=minimax ... trying minimax-2`。

但还有一个问题：**冷却**。没有冷却时，每个请求都要先撞一次已耗尽的账号。

### 1.3 语义不一致（任务 C）

面板和后端对「账号有没有额度」的判定不一样：

- `lib/kinds.ts:512` 的 `outOfCredits`：`windows.every(w => interval<=0 || weekly<=0)`
  —— 要求**所有窗口**都见底才算没钱
- 实测：`minimax` 的 `general` 5h 窗口 **0%**、`video` 窗口 **100%**
  → `every` 为 false → 账号仍算「有额度」→ 面板显示可用、路由不跳过
- 而文本模型走的是 `general` 窗口，请求必然 429

用户决定：**`video` 窗口后端直接无视、前端直接撤掉**。文本与视频是两套权益，
网关只服务文本，视频窗口不该影响文本模型的可路由性，也不该出现在面板上。

---

## 2. 已完成（工作区未提交）

`git status` 现状：9 个改动文件 + 5 个新文件，843 行新代码。

| 文件 | 行数 | 作用 |
|---|---|---|
| `lib/workbuddy/catalog-store.ts` | 62 | 目录在 `cache` 表的 `workbuddy:catalog` 行；**永不作废**，过期只表示该再抓 |
| `lib/cooldown.ts` | 115 | `cooldown` 表读写、`MAX_COOLDOWN_MS = 7 天` 上限、`ACCOUNT_COOLDOWN_MS` 可覆盖 |
| `lib/router/account-cooldown.ts` | 162 | 判定冷却时长：`COOLDOWN_GRACE_MS = 60_000`；`planWindowEndsAt()` 从健康快照取窗口结束时间 |
| `lib/health-cache.ts` | 9 | 路由里同步读健康快照（拿窗口时间用） |
| `test/cooldown-check.ts` | 495 | 25 项断言 |

改动文件：`lib/admin/upstreams.ts`(7) `lib/periodic.ts`(16)
`lib/router/provider-selection.ts`(1) `lib/router/upstreams.ts`(96) `lib/store.ts`(12)
`lib/upstream-status.ts`(45) `lib/workbuddy/models.ts`(33)
`lib/workbuddy/transport.ts`(47) `router-proxy.ts`(35)

### 已验证（只读检查，2026-10-27 11:49）

- `mise run typecheck`：0 错误
- `node --experimental-strip-types test/cooldown-check.ts`：**25 项全过**
  - 含「第一个请求换了账号」「冷却写进库」「重启后仍在冷却」「单一策略直接 503
    且不打上游」「提示里说了到什么时候」
- `mise run test` 全套：通过
  （selection 25 / policy 81 / upstream:status 13 / minimax:api:policy 12 /
  catalog-parity 22 / cleanup 44 / cleanup:admin 49 / policy:e2e 53）

### 已确认符合约定

- 截止时间 = `deadline.at + COOLDOWN_GRACE_MS`（窗口结束 + 1 分钟）
- 上限 `MAX_COOLDOWN_MS = 7 天`，任何路径都不会写出「永久」
- 只对**可降级**失败记冷却；400/404/413 不记

---

## 3. 待做（派小弟时照这个执行）

### 3.1 任务 A'：把新测试挂进 mise

`test/cooldown-check.ts` **还没**写进 `mise.toml`，现在全套测试不会跑它。

- 加独立 task：`test:cooldown`
- 加进 `[tasks.test]` 的 `depends` 数组

### 3.2 任务 B'：审查已有改动

三处需要逐行看，确认没有夹带：

| 位置 | 行数 | 看什么 |
|---|---|---|
| `router-proxy.ts` | 35 | 启动时从 DB 加载目录的顺序——必须在路由挂载前，且 `models()` 仍是同步的 |
| `lib/periodic.ts` | 16 | 清过期冷却行；不能阻塞主 tick |
| `lib/admin/upstreams.ts` | 7 | 面板接口里改了什么 |

审查标准（对不上就要改）：
- 目录读优先级：DB → 没有才用写死快照（并立刻触发一次抓取）
- 抓取失败时**不退回**写死快照，继续用 DB 里那份
- 冷却期间该账号**不出现在候选里**（不是「试一次再换」）
- 成功一次即清除冷却
- `single` 策略下冷却时直接报错（503 + 提示到什么时候），不打上游

### 3.3 任务 C'：面板与后端语义统一（`video` 撤掉）

目标：文本模型的可路由性与展示，只看 `general` 窗口；`video` 一律无视。

改动点（建议在一处过滤，避免三处各写一遍）：

1. **过滤位置**：`lib/kinds.ts:450` 的 `tokenPlanView()` 是面板与快照的共同入口
   （`lib/admin/upstreams.ts:648` 另有一份同名函数，注意同步）。
   在这里丢掉 `label`（即上游的 `model` 字段）为 `video` 的窗口。
   常量写成具名集合，例如 `IGNORED_PLAN_WINDOWS = new Set(["video"])`，注释说明
   「网关只服务文本模型，视频权益不参与路由也不上屏」。
2. **冷却的窗口时间**：`lib/router/account-cooldown.ts:131` 的
   `planWindowEndsAt()` 直接读健康快照的 `windows`，**也要跳过 `video`**，
   否则 `video` 的窗口结束时间会被当成恢复时间。
3. **`outOfCredits`**（`lib/kinds.ts:512`）：过滤后只剩 `general`，
   `every` 自然退化成「general 见底即没额度」。注释里那段
   「一个窗口用完只说明那批模型用完」要改写成现在的语义。
4. **前端**：`web/src/features/balance/token-plan.tsx:5-8` 的窗口名映射里删掉
   `video: '视频'`；`web/src/features/balance/quota.tsx:78` 的 `tokenPlanLine()`
   不需要改（窗口已被后端过滤掉），但要确认空窗口时的渲染。
5. **测试**：
   - 后端：`general` 0% + `video` 100% 时，`outOfCredits` 必须为 **true**
   - 冷却：`video` 窗口结束时间**不**被当成恢复时间
   - 前端：`web/src/features/balance/token-plan.test.tsx`、
     `web/src/features/upstreams/quota-display.test.tsx` 里的样例数据如果带
     `video`，改成只剩 `general`，并断言不渲染视频那一行

### 3.4 提交

- `mise run typecheck` 0 错误
- `mise run test` 全套全绿（含新挂的 `test:cooldown`）
- 前端测试：`pnpm --dir web test`（或仓库现有命令，看 `web/package.json`）
- 本地 `git commit`，英文消息，正文讲清三件事：目录落 DB、冷却两类、`video` 撤掉
- **不 deploy、不 push**

---

## 4. 派单须知

- 子代理**必须用 minimax 的额度**（用户指定）。当前 `minimax` 与 `minimax-2` 的
  `general` 5h 窗口都是 0%，要等 15:00 / 16:15（本地）之后
- 子代理**不要部署、不要推送、不要碰 NAS、不要改凭据、不要发真实上游请求**
- 测试一律用本机假上游（照 `test/minimax-fallback-check.ts` 的写法：真
  `router-proxy.ts` + 假上游 + 临时 `BUDDY_DATA_DIR`）

---

## 5. 相关事实（省得重新挖）

- 两个 MiniMax 账号现在的窗口（2026-10-27 12:00 实测）：
  - `minimax`：general 5h **0%** / 周 100%（窗口 15:00 结束）
  - `minimax-2`：general 5h **0%** / 周 70%（窗口 16:15 结束）
  - 两个都有 `video` 窗口 100%
- 429 + `code 2067` = Token Plan 用量上限；正文里**没有**恢复时间
- 带恢复时间的形状：`您的限额将在 2026-10-30 07:55:44 重置`（按 UTC+8 解析）
- 已部署的修复：`74f395d`（429 现在会换账号）
- 已部署未推送：`ed6123b`(zcode 日志) `3e3cdd2`(zcode 指纹) `ee49bb2`(zcode 目录)
  `1897eab`(workbuddy 头) `74f395d`(minimax fallback)
- 顺带一个已知小问题：`tools/migrate-credentials.ts` 引用了已删除的
  `legacySessionPath`，部署时会报 `SyntaxError`（脚本没跑，服务照常启动）。
  不在本次范围，但可以顺手修。
