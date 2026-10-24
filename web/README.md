# 管理面板

网关的管理面板：观测上游、账号凭据、余额、用量，管理主路由模型。

## 跑起来

```bash
pnpm install          # 第一次
pnpm dev              # 开发服务器，http://127.0.0.1:5173/admin/
pnpm build            # 产物在 dist/
pnpm typecheck        # 类型检查
pnpm test             # vitest
```

根目录有对应的 mise 任务：`mise run web:dev` / `web:build` / `web:typecheck` / `web:test`。

面板挂在网关的 `/admin` 下面，所以开发时也是这个前缀（vite 的 `base` 和
TanStack Router 的 `basepath` 都跟着它）。要改的话给 `VITE_PANEL_BASE` 一个值。

## 跟网关怎么连

- 接口是 protobuf + Connect，服务描述是 `buddy.admin.v1.AdminService`。
  契约在 `proto/buddy/admin/v1/admin.proto`，生成的 TypeScript 客户端在
  `lib/gen/`（仓库里共用的一份，不要拷进 `web/`）。
- 面板是网关自己托管的静态文件，所以请求打回同源，baseUrl 用相对地址
  （路径从根开始：`/buddy.admin.v1.AdminService/...`，不在 `/admin` 下面）。
  开发时 vite 把这个前缀代理到网关：

  ```bash
  GATEWAY_URL=http://127.0.0.1:6450 pnpm dev
  ```

  `GATEWAY_URL` 默认就是 `http://127.0.0.1:6450`。
- 鉴权走 `Authorization: Bearer <令牌>`。令牌是网关在 `/data/admin-token`
  生成的那一份，面板第一次打开时问一句，存在浏览器的 localStorage 里。
  令牌不对时网关回 401，面板会自动退回令牌输入页。

## 目录

```
src/
  components/
    ui/            shadcn/ui 组件（shadcn CLI 生成的，不要手改）
    data-table/    表格那套：工具条、列头、分页、视图选项
    layout/        侧边栏、顶栏、页面外壳
  features/
    auth/          令牌闸门、Connect 客户端的注入点
    overview/      总览
    upstreams/     Provider（账号与凭据也在这里：点一行展开）
    config/        配置
    accounts/      账号与凭据的数据层（查询、注销、租户 key）
    balance/       余额、赠金批次、套餐额度
    usage/         用量
    models/        主路由模型
  hooks/
    use-table-url-state.ts   分页、筛选、搜索同步到 URL
  lib/
    admin-client.ts   Connect 客户端（带鉴权拦截器）
    errors.ts         Connect 错误翻成人话
    format.ts         时间、金额、令牌的格式化
  routes/           TanStack Router 文件路由
```

## 页面

| 路由 | 页面 | 干什么 |
|---|---|---|
| `/` | 总览 | 各上游状态、余额、用量摘要 |
| `/upstreams` | Provider | Provider 列表（开关、地址、凭据摘要、额度），点一行展开它名下的账号与凭据 |
| `/config` | 配置 | 按分组切成 tab，每组几项写在 tab 上；配置项的当前值和来源，可改、可清回默认 |
| `/balance` | 余额 | 当前余额、套餐额度、赠金批次、到期倒计时 |
| `/usage` | 用量 | 汇总、按上游/模型/天分组、明细（筛选和分页在 URL 里） |
| `/models` | 主路由模型 | 聚合路由的增删改、策略、每个目标分到多少请求 |

账号与凭据没有单独的页面了：它在 Provider 页里，点一行 Provider 就展开
那个 Provider 名下的账号，账号再点一下看它名下的凭据。`/accounts` 留着，
进那一页跳到 `/upstreams`。

赠金批次的到期时间原样显示平台的日期：平台用 `2099-12-31` 标记「永不过期」，
面板不翻译它，倒计时那一列给「—」。

右上角能切主题：浅色 / 深色 / 跟随系统。选择存在 localStorage 里，
`index.html` 里有一段同逻辑的内联脚本，页面不会闪一下白。

## 几条容易踩的约定

- **契约里的时间戳是 Unix 毫秒**（网关那边是 `Date.now()`），只有名字里带
  `_sec` 的两个是秒：`uptime_sec` 和 `remaining_sec`。
- **敏感配置项只写不读**：服务端回的是空串，`has_value` 说明有没有值。
  面板把掩码当「有没有值」的提示，绝不当值回传（回传一次，库里就会多一个
  叫 `***` 的密钥）。
- **配置项给的是 `label`**（自然语言的名字），env 键名只放在次要位置。
- **配置页按 `group` 分组**，每组一个 tab，tab 名是中文的映射（`minimax` →
  「MiniMax」）。打开时停在「常规」那一组，哪怕它是空的。
- **面板能改的设置是热的**：改完立刻生效，不用重启。所以界面上不再提
  「重启后生效」。
- **服务端用 `HTTP 200 + ok:false` 表达失败**（不认识的配置项、上游 id 对不上、
  模型没有目标……）。前端在 `lib/errors.ts` 里用 `assertOk` 把它翻成异常，
  成功和失败只有一条路。
- **模型的元数据可以「继承上游」**：契约里上下文长度、输出上限、是否推理、
  是否工具都是 optional 的，不给就是继承。编辑一次不会把继承写死成具体数字。
- **上游能不能接由后端说**：`Upstream.state`（枚举）说了算 —— READY 才能选。
  面板不再自己拼「开着 && 登录了」。各个状态在界面上都有一句人话。
- **上游开关不存本地状态**：契约里 `Upstream.enabled` 就是现在的值（开关是
  热的，改完立刻生效），界面以服务端的答复为准。
- **凭据状态是枚举**：`CredentialStatus.status` 是 `CredentialState`（数字），
  不是字符串。`Account.status` 和 `Credential.status` 仍是字符串。
- **模型没公布有原因**：`PublishedModel.unpublished_reason`（`UnpublishedReason`）
  说明为什么根路由不公布它（模型停用了、上游关着、没登录、模型没了……）。
- **模型目录的缓存键带上上游状态**（`['catalog', upstreamId, state]`）：上游关着
  的时候 `ListModels` 不给模型，键不变的话界面上会留着上一次的目录。
- **模型目标只有权重，没有顺序**：权重大的先试，失败了才试小的。single 策略
  只走一个目标，权重没意义：不画输入框，发出去的权重统一是 1。
- **上游组只列能用的上游**：开着、而且凭据是已登录的。没登录的、关掉的都不
  列 —— 填了也接不了。组的模型 id 从那个上游的目录里选（可搜）；目录是空
  的时候明说「这个上游没有目录，手填模型 id」，不静悄悄地退化。
- **主路由模型可以直接发布/停用**：列表里就有按钮，不用去弹窗里翻开关。
  停用要确认（停用之后根路由就不公布它了）。
- **主路由模型的「公布数」按 `published` 算**：模型在库里不等于根路由公布了
  （上游全关着、或者目标模型的上游没了，都没人能接）。
- **登录授权**：面板给链接，用户在自己浏览器里同意，面板每 3 秒问一次进度。
  没走完的登录记在 URL 的 hash 里（`#/admin/upstreams#login=xxx`），刷新页面
  还能接上。路由用的是 history，hash 路由没用，两边不打架。
- **账号按 Provider 分组**：一个 Provider 名下可能有几个账号（TokenRhythm 一
  个租户一个账号），所以账号表在 Provider 那一行下面，不是一张平铺的表。
- **登录还是注销看账号的状态**：`Account.status` 是 `usable` 就给「注销」，
  其余（没有凭据、已过期）给「登录」。注销前要确认，注销完账号回到「没有
  凭据」，「登录」按钮又出来。
- **后端给的话是「中文（机器码）」**：机器码是给日志看的，面板上只显示中文。
- **模型目标只有权重，没有顺序**：权重大的先试，失败了才试小的。
