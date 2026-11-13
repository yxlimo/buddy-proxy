import type { UpstreamQuota } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 这块额度里有没有数。
 *
 * 余额 0、积分 0 都算没数：平台有时会先给一条空壳记录（额度已经用完），
 * 归并时要跳过空壳记录，去找真正带数的那条。
 *
 * 只看还剩多少（余额的 availableCny、积分的 remaining）：已用多少、什么时候
 * 到期都不算「有值」 —— 那两个字段不说明还剩多少。额度用尽的账号不该被
 * 当成可用。
 */
function hasCredits(credits: UpstreamQuota['credits']): boolean {
  if (!credits) return false
  return credits.remaining > 0
}

function hasBalance(balance: UpstreamQuota['balance']): boolean {
  if (!balance) return false
  return balance.availableCny > 0
}

/** 换掉额度记录里的三块内容，账号身份信息保持不变。 */
function replaceParts(
  quota: UpstreamQuota,
  parts: Pick<UpstreamQuota, 'tokenPlan' | 'credits' | 'balance'>,
): UpstreamQuota {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(quota)) as UpstreamQuota,
    quota,
  )
  return Object.assign(copy, parts)
}

/**
 * 同一账号的多条额度记录归并成一条。
 *
 * 按 upstreamId + accountId 归组，保留首次出现的顺序。
 * 额度单位不同（套餐额度是百分点，积分是点数，余额是钱），所以不求和：
 * 套餐额度取第一个有窗口的，积分与余额取第一个带数的，都没有就留第一条的。
 */
export function mergeQuotas(quotas: UpstreamQuota[]): UpstreamQuota[] {
  const groups = new Map<string, UpstreamQuota[]>()
  for (const quota of quotas) {
    const key = `${quota.upstreamId}|${quota.accountId}`
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(quota)
    } else {
      groups.set(key, [quota])
    }
  }

  const merged: UpstreamQuota[] = []
  for (const bucket of groups.values()) {
    const first = bucket[0]
    const tokenPlan =
      bucket.find((quota) => (quota.tokenPlan?.windows?.length ?? 0) > 0)?.tokenPlan ??
      first.tokenPlan
    const credits =
      bucket.find((quota) => hasCredits(quota.credits))?.credits ?? first.credits
    const balance =
      bucket.find((quota) => hasBalance(quota.balance))?.balance ?? first.balance
    merged.push(replaceParts(first, { tokenPlan, credits, balance }))
  }
  return merged
}

/**
 * 这一份额度能说多少话，用它在平台那一行里挑最有信息量的那一条。
 *
 * 有套餐额度就算最有信息量，其次是积分，再其次是余额；一个数都没有的是 0。
 * 三样各自是各自的单位，比的是「有没有话可说」，不是大小。
 */
export function quotaRank(quota: UpstreamQuota): number {
  if ((quota.tokenPlan?.windows?.length ?? 0) > 0) return 3
  if (quota.credits) return 2
  if (quota.balance) return 1
  return 0
}

/** 一个平台名下的额度。 */
export type PlatformQuotas = {
  /** 平台 id。 */
  upstreamId: string
  /** 这个平台名下的账号，按服务端给的次序。 */
  accounts: UpstreamQuota[]
}

/**
 * 一个平台一组。
 *
 * 组与组之间的次序沿用服务端清单里首次出现的次序（也就是平台自己的排序），
 * 组内是账号的次序。归并先做：同一账号的多条记录只留下一条。
 */
export function groupQuotasByPlatform(quotas: UpstreamQuota[]): PlatformQuotas[] {
  const platforms: PlatformQuotas[] = []
  const index = new Map<string, PlatformQuotas>()
  for (const quota of mergeQuotas(quotas)) {
    const upstreamId = quota.upstreamId
    let platform = index.get(upstreamId)
    if (!platform) {
      platform = { upstreamId, accounts: [] }
      index.set(upstreamId, platform)
      platforms.push(platform)
    }
    platform.accounts.push(quota)
  }
  return platforms
}

/**
 * 一行摘要用哪一条：最有信息量的那一条。
 *
 * 都没有数就是 undefined —— 调用方据此说「没有额度」，不拿 0 顶上。
 */
export function primaryQuota(
  accounts: UpstreamQuota[],
): UpstreamQuota | undefined {
  let best: UpstreamQuota | undefined
  let bestRank = 0
  for (const account of accounts) {
    const rank = quotaRank(account)
    if (rank > bestRank) {
      best = account
      bestRank = rank
    }
  }
  return best
}
