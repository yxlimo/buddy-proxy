import { RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState } from '@/components/async-state'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  balanceKeys,
  useBalances,
  useRefreshBalance,
} from '@/features/balance/api'
import {
  groupQuotasByPlatform,
  type PlatformQuotas,
} from '@/features/balance/platform-quotas'
import {
  PlatformQuotaError,
  PlatformQuotaRow,
  PlatformQuotaSkeleton,
} from '@/features/balance/platform-row'
import { useUpstreams } from '@/features/upstreams/api'
import type { UpstreamQuota } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 收起时最多摆几个平台。
 *
 * 平台多的机器一屏放不下：收起时只摆前几个（次序照平台自己的排序），
 * 其余的收在「展开全部」后面。
 */
const ROW_LIMIT = 5

/** 额度页上的一行：平台清单里的一家，加它这一趟的额度查询。 */
type PlatformRow = {
  /** 平台 id。行容器的 aria-label 用它：名字改得了，id 改不了。 */
  upstreamId: string
  /** 行标题：平台的显示名。 */
  title: string
  query: ReturnType<typeof useBalances>[number]
}

/** 这一行属于哪个平台：按平台 id 从这一趟的答复里挑出它的账号。 */
function platformOf(
  upstreamId: string,
  quotas: UpstreamQuota[],
): PlatformQuotas {
  return (
    groupQuotasByPlatform(quotas).find(
      (platform) => platform.upstreamId === upstreamId,
    ) ?? { upstreamId, accounts: [] }
  )
}

/** 一行平台额度：还没回来摆骨架，崩了报错，到手了给摘要行。 */
function PlatformRowEntry({ row, refreshing }: { row: PlatformRow; refreshing: boolean }) {
  const { upstreamId, title, query } = row
  if (query.isPending) {
    return <PlatformQuotaSkeleton upstreamId={upstreamId} title={title} />
  }
  if (query.isError) {
    return (
      <PlatformQuotaError
        upstreamId={upstreamId}
        title={title}
        error={query.error as Error}
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }
  return (
    <PlatformQuotaRow
      platform={platformOf(upstreamId, query.data?.quotas ?? [])}
      title={title}
      refreshing={refreshing}
    />
  )
}

/**
 * 额度页：一个平台一行，收起时只给摘要，点开看各账号的明细。
 *
 * 行集合来自平台清单（`ListUpstreams`），额度（`GetBalance`）按平台并进去。
 * 左连接：平台一条额度都没回、或者根本没有账号，它照样有一行 —— 额度页不该
 * 因为「那一趟答复里没有它」就把一个平台漏掉。
 *
 * 余额、积分与套餐额度分别列示：单位不同，任何地方都不相加。
 */
export function BalancePage() {
  // 平台清单：行集合由它定，次序也是它的。
  const platforms = useUpstreams()
  const refresh = useRefreshBalance('')
  const queryClient = useQueryClient()
  /** 平台多的时候，收起只摆前几个；这一位是「其余的都摆出来」。 */
  const [showAll, setShowAll] = useState(false)

  // 该问哪几家额度：平台清单说一家问一趟。
  const platformIds = useMemo(
    () => (platforms.data?.upstreams ?? []).map((upstream) => upstream.id),
    [platforms.data],
  )

  // 每家平台各问一趟：谁先回来谁先渲染，慢的不拖累快的。
  const queries = useBalances(platformIds)

  const onRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: () => {
        // 全量刷完，各家那条也重新问一遍，行里的数换成刚问回来的。
        for (const upstreamId of platformIds) {
          queryClient.invalidateQueries({
            queryKey: balanceKeys.all(upstreamId),
          })
        }
      },
    })
  }

  // 全家都没问出来：给一个统一入口，不用一行一行点重试。
  // 只有部分失败不算 —— 那时逐行报错更清楚是哪几家出的问题。
  const allFailed = queries.length > 0 && queries.every((query) => query.isError)

  const onRetryAll = () => {
    for (const query of queries) {
      if (query.isError) {
        void query.refetch()
      }
    }
  }

  // 一行一个平台：平台清单是左表，额度按 id 并进去。
  const rows: PlatformRow[] = (platforms.data?.upstreams ?? []).map(
    (upstream, index) => ({
      upstreamId: upstream.id,
      // 面板别处都是「有名字写名字，没名字写 id」。
      title: upstream.label?.trim() || upstream.id,
      query: queries[index],
    }),
  )
  const visible = showAll ? rows : rows.slice(0, ROW_LIMIT)
  const hiddenCount = rows.length - visible.length

  return (
    <PageShell
      title='额度'
      description='一个平台一行，点开看各账号的额度。余额、积分与套餐额度分别列示。'
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
      {platforms.isPending ? (
        <QuotaSkeletonList />
      ) : platforms.isError ? (
        <ErrorState
          error={platforms.error}
          onRetry={() => platforms.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyQuotaCard />
      ) : (
        <>
          {allFailed ? (
            <AllUpstreamsFailedNotice onRetry={onRetryAll} />
          ) : null}
          <ul aria-label='平台额度' className='grid gap-3'>
            {visible.map((row) =>
              row.query ? (
                <PlatformRowEntry
                  key={row.upstreamId}
                  row={row}
                  refreshing={refresh.isPending || row.query.isFetching}
                />
              ) : (
                <PlatformQuotaSkeleton
                  key={row.upstreamId}
                  upstreamId={row.upstreamId}
                  title={row.title}
                />
              ),
            )}
          </ul>
          {hiddenCount > 0 ? (
            <div className='mt-4'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setShowAll(true)}
              >
                展开全部 {rows.length} 个平台
              </Button>
            </div>
          ) : null}
          {rows.length > ROW_LIMIT && showAll ? (
            <div className='mt-4'>
              <Button variant='outline' size='sm' onClick={() => setShowAll(false)}>
                收起
              </Button>
            </div>
          ) : null}
        </>
      )}
    </PageShell>
  )
}

/**
 * 所有平台都没问出来：一行提示加一个统一重试。
 *
 * 逐行点重试在「全军覆没」时最烦人 —— 每一行底下都有一个重试按钮，
 * 用户得挨个点。这里一次全部重问。
 */
function AllUpstreamsFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className='mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3'>
      <p className='text-sm text-destructive'>所有平台都没问出来</p>
      <Button variant='outline' size='sm' onClick={onRetry}>
        全部重试
      </Button>
    </div>
  )
}

/**
 * 骨架：平台清单还没回来，先把位置占住。
 *
 * 清单到了之后每一行的骨架由 `PlatformQuotaSkeleton` 摆（那时已经知道有几家）。
 */
function QuotaSkeletonList() {
  return (
    <div>
      <p className='mb-4 text-sm text-muted-foreground'>正在读取额度…</p>
      <ul aria-label='平台额度' className='grid gap-3'>
        {[0, 1, 2].map((index) => (
          <li key={index} className='rounded-lg border px-4 py-3'>
            <div className='h-4 w-24 animate-pulse rounded bg-muted' />
            <div className='mt-2 h-3 w-16 animate-pulse rounded bg-muted' />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 一个平台都没有：平台清单本身是空的。 */
function EmptyQuotaCard() {
  return (
    <Card>
      <CardContent className='py-12 text-center text-sm text-muted-foreground'>
        网关没有返回任何平台
      </CardContent>
    </Card>
  )
}
