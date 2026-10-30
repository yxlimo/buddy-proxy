import { RefreshCw } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState, LoadingState } from '@/components/async-state'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useBalance, useRefreshBalance } from '@/features/balance/api'
import { QuotaDetail } from '@/features/balance/quota'
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

export function BalancePage() {
  const balance = useBalance('')
  const refresh = useRefreshBalance('')

  if (balance.isPending) {
    return <LoadingState />
  }
  if (balance.isError) {
    return (
      <ErrorState error={balance.error} onRetry={() => balance.refetch()} />
    )
  }

  const quotas = mergeQuotas(balance.data.quotas)

  return (
    <PageShell
      title='额度'
      description='各账号的额度。余额、积分与套餐额度分别列示。'
      actions={
        <Button
          variant='outline'
          size='sm'
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'}
          />
          {refresh.isPending ? '正在刷新…' : '刷新额度'}
        </Button>
      }
    >

      {quotas.length === 0 ? (
        <Card>
          <CardContent className='py-12 text-center text-sm text-muted-foreground'>
            Provider 没有报额度。
          </CardContent>
        </Card>
      ) : (
        quotas.map((quota) => (
          <QuotaCard
            key={`${quota.upstreamId}|${quota.accountId}`}
            quota={quota}
          />
        ))
      )}
    </PageShell>
  )
}

/**
 * 一个账号的额度卡。
 *
 * 标题按账号分：主行写账号，账号没报就写上游；副行小字写上游。
 */
function QuotaCard({ quota }: { quota: UpstreamQuota }) {
  const title = quota.accountId || quota.upstreamId || '未知 Provider'
  const subtitle = quota.upstreamId === title ? '' : quota.upstreamId
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>{title}</CardTitle>
          {subtitle ? (
            <p className='text-xs text-muted-foreground'>{subtitle}</p>
          ) : null}
        </CardHeader>
        <CardContent className='px-0'>
          <QuotaDetail quota={quota} />
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}
