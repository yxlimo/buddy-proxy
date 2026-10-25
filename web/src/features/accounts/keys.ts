/**
 * 账号相关的查询键。
 *
 * 单独一个文件：`features/upstreams/api.ts` 与 `features/accounts/api.ts` 两边都要
 * 用，互相 import 会绕成环。键放在这里，两边都从这里取。
 */
export const accountKeys = {
  all: ['accounts'] as const,
  credentials: (accountId: string) =>
    ['accounts', accountId, 'credentials'] as const,
}
