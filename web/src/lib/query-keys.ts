/**
 * 面板读的服务端数据，每一份的查询键。
 *
 * 键单独放一处：几份数据是互相牵着的（改一个账号，平台那份答复里也变了），
 * 键散在各家文件里就会互相 import 绕成环，而且「改完哪些查询该重取」也没法
 * 集中写一遍。谁读哪一份、改完谁失效，见 `lib/server-data.ts`。
 *
 * 各 feature 仍然按自己的名字导出这些键（`upstreamKeys` 之类），别处 import
 * 的地方不用改。
 */
export const queryKeys = {
  /** 平台列表：平台、它名下的账号、策略、状态，都在同一份答复里。 */
  upstreams: {
    all: ['upstreams'] as const,
  },
  /** 账号名下的凭据。 */
  accounts: {
    all: ['accounts'] as const,
    credentials: (accountId: string) =>
      ['accounts', accountId, 'credentials'] as const,
  },
  /**
   * 额度：余额、积分、套餐。
   *
   * `all(id)` 是一家上游那一份（空串是「所有上游」那一次全量）；
   * `root` 是这一整摊的前缀，失效时用它（一家一家列不出来）。
   */
  balances: {
    root: ['balance'] as const,
    all: (upstreamId: string) => ['balance', upstreamId] as const,
  },
  /** 今天的签到状态：所有账号共用一份。 */
  benefits: {
    all: ['benefits'] as const,
  },
  /** 主路由模型。 */
  publishedModels: {
    all: ['published-models'] as const,
  },
  /**
   * 上游的模型目录。
   *
   * 键里带着上游的状态：状态变了目录也变了（关着的上游不返回目录），键不
   * 变的界面会留着上一次那份。
   */
  catalog: {
    all: ['catalog'] as const,
    models: (upstreamId: string, state: number) =>
      ['catalog', upstreamId, state] as const,
  },
  /** 总览那份状态：网关概况、各平台的可用情况与额度概况。 */
  system: {
    status: ['system', 'status'] as const,
    usage: (upstreamId: string, window: string) =>
      ['system', 'usage', upstreamId, window] as const,
  },
  /** 配置项。 */
  config: {
    all: ['config'] as const,
  },
  /** 服务端登记的额度插件：平台那一格选插件用。 */
  quotaPlugins: {
    all: ['quota-plugins'] as const,
  },
  /** 建平台时能选的类型（方言）：新增平台那一格选类型、平台卡片说类型用。 */
  platformKinds: {
    all: ['platform-kinds'] as const,
  },
} as const
