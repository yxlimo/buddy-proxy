import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

/**
 * 服务端的数据分这几摊。
 *
 * 这是一条规矩的唯一一处：mutation 只说「我改了哪摊数据」，改完该重新取哪些
 * 查询由下面那张表查出来。每个 mutation 各写一遍 key 就是每处都可能少写一个，
 * 少写的那一处当下不会报错，只是界面上看不见刚改的东西、要手动刷页面。
 */
export type ServerData =
  /** 平台表：增删改一个平台、它的模型目录、它的生效策略。 */
  | 'platforms'
  /** 账号行：增删改、开关、别名、权重。 */
  | 'accounts'
  /** 账号名下的凭据：贴 key、登录成功、试一条凭据。 */
  | 'credentials'
  /** 额度：余额、积分、套餐额度。 */
  | 'quotas'
  /** 今天的签到状态。 */
  | 'benefits'
  /** 主路由模型。 */
  | 'publishedModels'
  /** 配置项。 */
  | 'config'

/**
 * 账号那一行牵着的查询。
 *
 * 账号在平台那份答复里（`Upstream.accounts`，带着凭据条数与状态）、在账号那份
 * 答复里（凭据）、在总览里、在额度页里（一个账号一张卡）。凭据是账号行的一部分
 * （写着凭据条数、可不可用），所以凭据变了这份也一样失效。
 */
const accountReaders = [
  queryKeys.upstreams.all,
  queryKeys.accounts.all,
  queryKeys.system.status,
  queryKeys.balances.root,
] as const

/**
 * 每一摊数据由哪些查询在读。
 *
 * 加一摊数据就加一行；加一个读数据的查询，记得回头看看它读的那摊在不在表里。
 */
const readers: Record<ServerData, readonly (readonly unknown[])[]> = {
  // 平台那份答复（带账号）、总览（按平台列可用情况）、额度页（按上游分卡片）、
  // 模型目录（开放平台的目录就是平台上那份 models）。
  platforms: [
    queryKeys.upstreams.all,
    queryKeys.system.status,
    queryKeys.balances.root,
    queryKeys.catalog.all,
  ],
  accounts: accountReaders,
  credentials: accountReaders,
  // 额度页那份，和总览里按平台给的那几行。额度变了平台那份答复也变了（平台上
  // 带着额度快照与结论），所以额度也读平台那一份。
  quotas: [
    queryKeys.balances.root,
    queryKeys.system.status,
    queryKeys.upstreams.all,
  ],
  benefits: [queryKeys.benefits.all],
  publishedModels: [queryKeys.publishedModels.all],
  config: [queryKeys.config.all, queryKeys.system.status],
}

/**
 * 改完之后让读这些数据的查询重新取数。
 *
 * 在 mutation 的 onSettled 里调：有的失败里服务端已经改了一半（删平台是先删
 * 指着它的模型再删平台），所以失败也重取一次，看见的就还是服务端那份真值。
 */
export function invalidateServerData(
  queryClient: QueryClient,
  ...changed: ServerData[]
): void {
  // 同一份键只发一次：invalidateQueries 默认会取消正在跑的那次重取再重来，
  // 同一份数据被几个 mutation 一起失效时，重复发就成了互相打断。
  const seen = new Set<string>()
  for (const data of changed) {
    for (const key of readers[data]) {
      const id = JSON.stringify(key)
      if (seen.has(id)) continue
      seen.add(id)
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
}
