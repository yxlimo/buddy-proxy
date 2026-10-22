# 管理面板

网关的管理面板：观测上游、账号凭据、余额、用量，管理聚合路由公布的模型。

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
    upstreams/     上游
    config/        配置
    accounts/      账号与凭据
    balance/       余额与赠金批次
    usage/         用量
    models/        公布的模型
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
| `/upstreams` | 上游 | 开关上游（改了要重启才生效）、地址与区域 |
| `/config` | 配置 | 配置项的当前值和来源，可改、可清回默认 |
| `/accounts` | 账号与凭据 | 账号、余额、凭据（只有掩码和指纹）、试一下、强制刷新 |
| `/balance` | 余额 | 当前余额、赠金批次、到期倒计时 |
| `/usage` | 用量 | 汇总、按上游/模型/天分组、明细（筛选和分页在 URL 里） |
| `/models` | 公布的模型 | 聚合路由的增删改、策略、每个目标分到多少请求 |

赠金批次的到期时间原样显示平台的日期：平台用 `2099-12-31` 标记「永不过期」，
面板不翻译它，倒计时那一列给「—」。

## 几条容易踩的约定

- **契约里的时间戳是 Unix 毫秒**（网关那边是 `Date.now()`），只有名字里带
  `_sec` 的两个是秒：`uptime_sec` 和 `remaining_sec`。
- **敏感配置项只写不读**：服务端回的是掩码 `***`，面板把它当「有没有值」的
  提示，绝不当值回传（回传一次，库里就会多一个叫 `***` 的密钥）。
- **服务端用 `HTTP 200 + ok:false` 表达失败**（不认识的配置项、上游 id 对不上、
  模型没有目标……）。前端在 `lib/errors.ts` 里用 `assertOk` 把它翻成异常，
  成功和失败只有一条路。
- **模型的元数据可以「继承上游」**：契约里上下文长度、输出上限、是否推理、
  是否工具都是 optional 的，不给就是继承。编辑一次不会把继承写死成具体数字。
