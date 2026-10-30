import { RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState } from '@/components/async-state'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  balanceKeys,
  useBalance,
  useBalances,
  useRefreshBalance,
} from '@/features/balance/api'
import { QuotaDetail } from '@/features/balance/quota'
import { describeError } from '@/lib/errors'
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

/** 一条上游的额度查询。 */
type BalanceQuery = ReturnType<typeof useBalances>[number]

export function BalancePage() {
  // 全量这一趟只拿来认上游：谁家有哪些账号由它定。
  const list = useBalance('')
  const refresh = useRefreshBalance('')
  const queryClient = useQueryClient()

  // 上游清单：全量数据里出现过的上游，按头一次出现的次序。
  const upstreamIds = useMemo(() => {
    const ids: string[] = []
    for (const quota of list.data?.quotas ?? []) {
      if (quota.upstreamId && !ids.includes(quota.upstreamId)) {
        ids.push(quota.upstreamId)
      }
    }
    return ids
  }, [list.data])

  // 每家上游各问一趟：谁先回来谁先渲染，慢的不拖累快的。
  const queries = useBalances(upstreamIds)

  const onRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: () => {
        // 全量刷完，各上游那条也重新问一遍，卡片里的数换成刚问回来的。
        for (const upstreamId of upstreamIds) {
          queryClient.invalidateQueries({
            queryKey: balanceKeys.all(upstreamId),
          })
        }
      },
    })
  }

  const cardCount = queries.reduce(
    (sum, query) =>
      sum + (query.isSuccess ? mergeQuotas(query.data?.quotas ?? []).length : 0),
    0
  )
  const pending = queries.some((query) => query.isPending)
  const failed = queries.some((query) => query.isError)

  return (
    <PageShell
      title='额度'
      description='各账号的额度。余额、积分与套餐额度分别列示。'
      actions={
        <Button
          variant='outline'
          size='sm'
          disabled={refresh.isPending}
          onClick={onRefresh}
        >
          <RefreshCw
            className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'}
          />
          {refresh.isPending ? '正在刷新…' : '刷新额度'}
        </Button>
      }
    >
      {list.isPending ? (
        <QuotaSkeletonList />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : upstreamIds.length === 0 ? (
        <EmptyQuotaCard />
      ) : (
        <>
          {upstreamIds.map((upstreamId, index) => {
            const query = queries[index]
            if (!query) return null
            return (
              <UpstreamQuotaCards
                key={upstreamId}
                upstreamId={upstreamId}
                query={query}
                refreshing={refresh.isPending || query.isFetching}
              />
            )
          })}
          {!pending && !failed && cardCount === 0 ? (
            <EmptyQuotaCard />
          ) : null}
        </>
      )}
    </PageShell>
  )
}

/**
 * 一家上游的额度卡。
 *
 * 这一家还没问回来：先摆骨架。问失败了：只这一张卡报错，别的卡照常。
 */
function UpstreamQuotaCards({
  upstreamId,
  query,
  refreshing,
}: {
  upstreamId: string
  query: BalanceQuery
  refreshing: boolean
}) {
  if (query.isPending) {
    return <QuotaSkeletonCard title={upstreamId} />
  }
  if (query.isError) {
    return (
      <QuotaErrorCard
        upstreamId={upstreamId}
        error={query.error as Error}
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }
  const quotas = mergeQuotas(query.data?.quotas ?? [])
  return (
    <>
      {quotas.map((quota) => (
        <QuotaCard
          key={`${quota.upstreamId}|${quota.accountId}`}
          quota={quota}
          refreshing={refreshing}
        />
      ))}
    </>
  )
}

/**
 * 一个账号的额度卡。
 *
 * 标题按账号分：主行写账号，账号没报就写上游；副行小字写上游。
 */
function QuotaCard({
  quota,
  refreshing,
}: {
  quota: UpstreamQuota
  refreshing?: boolean
}) {
  const title = quota.accountId || quota.upstreamId || '未知 Provider'
  const subtitle = quota.upstreamId === title ? '' : quota.upstreamId
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <CardTitle className='text-base'>{title}</CardTitle>
            {refreshing ? (
              <RefreshCw
                className='size-3 animate-spin text-muted-foreground'
                aria-label='刷新中'
              />
            ) : null}
          </div>
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

/** 一家上游的额度没问出来：只这张卡自己报错。 */
function QuotaErrorCard({
  upstreamId,
  error,
  onRetry,
}: {
  upstreamId: string
  error: Error
  onRetry: () => void
}) {
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>{upstreamId}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            这一家的额度没问出来
          </p>
        </CardHeader>
        <CardContent className='px-0'>
          <div className='grid gap-3 px-6 pb-4'>
            <p className='text-sm text-destructive'>{describeError(error)}</p>
            <div>
              <Button variant='outline' size='sm' onClick={onRetry}>
                重试
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}

/**
 * 额度卡片的骨架：数还没回来，先把位置占住。
 *
 * 首屏清单还没到的时候不知道有几家上游，就先摆几张空卡。
 */
function QuotaSkeletonList() {
  return (
    <div>
      <p className='mb-4 text-sm text-muted-foreground'>正在读取额度…</p>
      {[0, 1, 2].map((index) => (
        <QuotaSkeletonCard key={index} />
      ))}
    </div>
  )
}

function QuotaSkeletonCard({ title }: { title?: string }) {
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>
            {title ?? (
              <span className='block h-4 w-24 animate-pulse rounded bg-muted' />
            )}
          </CardTitle>
          <div className='mt-1 h-3 w-16 animate-pulse rounded bg-muted' />
        </CardHeader>
        <CardContent className='px-0'>
          <div className='grid gap-3 px-6 pb-4'>
            <div className='h-4 w-32 animate-pulse rounded bg-muted' />
            <div className='h-3 w-48 animate-pulse rounded bg-muted' />
          </div>
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}

function EmptyQuotaCard() {
  return (
    <Card>
      <CardContent className='py-12 text-center text-sm text-muted-foreground'>
        Provider 没有报额度。
      </CardContent>
    </Card>
  )
}
