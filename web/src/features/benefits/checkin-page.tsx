import { useMemo } from 'react'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState } from '@/components/async-state'
import { Button } from '@/components/ui/button'
import { useUpstreams } from '@/features/upstreams/api'
import { useBenefitStatus, useRunBenefitNow } from '@/features/upstreams/benefits'
import { describeError } from '@/lib/errors'
import { useOrderedPlatforms } from '@/lib/platform-order'
import { PlatformCheckinRow } from '@/features/benefits/platform-checkin-row'
import type { BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 签到页：一个平台一行，收起时只给摘要，点开看逐条明细。
 *
 * 行集合取平台清单（`ListUpstreams`），签到状态按平台 id 并进去：没有签到
 * 记录的平台照样占一行，写「没有签到记录」，不写成 0。
 */
export function CheckinPage() {
  const platforms = useUpstreams()
  const status = useBenefitStatus()
  const run = useRunBenefitNow()

  const benefits = useMemo(() => {
    const map = new Map<string, BenefitStatus[]>()
    for (const benefit of status.data?.benefits ?? []) {
      const list = map.get(benefit.upstreamId) ?? []
      list.push(benefit)
      map.set(benefit.upstreamId, list)
    }
    return map
  }, [status.data])

  // 账号别名：展开明细里每条记录要能看出是哪个账号，拿别名，拿不到退回 id。
  const accountAliases = useMemo(() => {
    const map = new Map<string, string>()
    for (const upstream of platforms.data?.upstreams ?? []) {
      for (const account of upstream.accounts) {
        const alias = account.alias?.trim()
        if (alias) map.set(account.id, alias)
      }
    }
    return map
  }, [platforms.data])

  // 一行一个平台，次序照操作者自己排的那一份（平台页上拖出来的）。
  const rows = useOrderedPlatforms(
    useMemo(() => platforms.data?.upstreams ?? [], [platforms.data]),
  ).map((upstream) => ({
    upstreamId: upstream.id,
    title: upstream.label?.trim() || upstream.id,
  }))

  const runLines = run.data?.lines ?? []

  return (
    <PageShell
      title='签到'
      description='按平台列出签到状态与明细。'
      actions={
        <Button size='sm' onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? '签到中…' : '立即签到'}
        </Button>
      }
    >
      {platforms.isPending ? (
        <div>
          <p className='mb-4 text-sm text-muted-foreground'>正在读取签到状态…</p>
          <ul aria-label='平台签到' className='grid gap-3'>
            {[0, 1, 2].map((index) => (
              <li key={index} className='rounded-lg border px-4 py-3'>
                <div className='h-4 w-24 animate-pulse rounded bg-muted' />
                <div className='mt-2 h-3 w-16 animate-pulse rounded bg-muted' />
              </li>
            ))}
          </ul>
        </div>
      ) : platforms.isError ? (
        <ErrorState error={platforms.error} onRetry={() => platforms.refetch()} />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : rows.length === 0 ? (
        <p className='rounded-lg border px-4 py-12 text-center text-sm text-muted-foreground'>
          网关没有返回任何平台
        </p>
      ) : (
        <>
          {run.isError ? (
            <p
              aria-label='签到失败'
              className='mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive'
            >
              {describeError(run.error as Error)}
            </p>
          ) : null}

          {run.data ? (
            <div
              aria-label='本次签到'
              className='mb-4 grid gap-1 rounded-lg border px-4 py-3'
            >
              <span className='text-sm font-medium'>本次签到</span>
              {runLines.length > 0 ? (
                <ul className='grid gap-0.5 text-sm'>
                  {runLines.map((line, index) => (
                    <li key={`${index}-${line}`} className='break-words'>
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className='text-sm text-muted-foreground'>没有输出</span>
              )}
            </div>
          ) : null}

          <ul aria-label='平台签到' className='grid gap-3'>
            {rows.map((row) => (
              <PlatformCheckinRow
                key={row.upstreamId}
                upstreamId={row.upstreamId}
                title={row.title}
                benefits={benefits.get(row.upstreamId)}
                accountAliases={accountAliases}
              />
            ))}
          </ul>
        </>
      )}
    </PageShell>
  )
}
