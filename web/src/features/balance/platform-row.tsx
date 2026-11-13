import { useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  NoQuotaNotice,
  QuotaDetail,
  QuotaSummary,
  quotaStateText,
} from '@/features/balance/quota'
import {
  primaryQuota,
  type PlatformQuotas,
} from '@/features/balance/platform-quotas'
import { describeError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { UpstreamQuota } from '@/gen/buddy/admin/v1/admin_pb'

/** 明细区的 id：展开时 `aria-controls` 指过来，e2e 也照它定位。 */
function detailId(upstreamId: string): string {
  return `quota-detail-${upstreamId}`
}

/** 账号叫什么：先看名字，没有名字退回账号 id，再没有就写平台。 */
function accountLabel(account: UpstreamQuota, upstreamId: string): string {
  return account.accountName?.trim() || account.accountId || upstreamId
}

/** 副行只说主行没说的那一层，同一段信息不写两遍。 */
function accountSubtitle(
  account: UpstreamQuota,
  upstreamId: string,
): string {
  const label = accountLabel(account, upstreamId)
  // 账号 id 就是标题、或者就是平台 id（行上已经写着）的时候不再重复。
  if (!account.accountId) return ''
  if (account.accountId === label || account.accountId === upstreamId) return ''
  return `账号 ${account.accountId}`
}

/**
 * 一个平台一行，收起时只给摘要。
 *
 * 行上写平台名、账号数与服务端给的结论，右侧是最有信息量的那一档额度；
 * 点这一行才展开看各账号的明细。默认是收起的：平台多的时候一屏能看全。
 *
 * 空额度不隐掉：没有数字的平台也占一行，写「没有额度」，不写成 0。
 */
export function PlatformQuotaRow({
  platform,
  title,
  refreshing,
}: {
  platform: PlatformQuotas
  /** 行标题：平台的显示名，没有就是 id。 */
  title?: string
  refreshing?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const { upstreamId, accounts } = platform
  const primary = primaryQuota(accounts)
  // 服务端给的结论（用尽 / 不能用 / 凭据被拒……）：行上跟着账号数一起写。
  const stateText = accounts.map(quotaStateText).find((text) => text) ?? null
  const id = detailId(upstreamId)

  return (
    <li
      aria-label={`${upstreamId} 额度行`}
      className='rounded-lg border'
    >
      <button
        type='button'
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => setExpanded((open) => !open)}
        className='flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50'
      >
        <span className='grid min-w-0 gap-1'>
          <span className='flex items-center gap-2 text-sm font-medium'>
            {title || upstreamId || '未知平台'}
            {refreshing ? (
              <RefreshCw
                className='size-3 animate-spin text-muted-foreground'
                aria-label='刷新中'
              />
            ) : null}
          </span>
          <span className='text-xs text-muted-foreground'>
            {accounts.length > 0 ? `${accounts.length} 个账号` : '没有账号'}
            {stateText ? ` · ${stateText}` : ''}
          </span>
        </span>
        <span className='flex min-w-0 items-center gap-2'>
          <span className='min-w-0'>
            {primary ? (
              <QuotaSummary quota={primary} align='start' />
            ) : (
              <span className='text-xs text-muted-foreground'>没有额度</span>
            )}
          </span>
          <ChevronDown
            aria-hidden='true'
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </span>
      </button>

      {expanded ? (
        <div
          id={id}
          role='region'
          aria-label={`${upstreamId || '未知平台'} 额度明细`}
          className='border-t'
        >
          <ul aria-label='账号额度' className='divide-y'>
            {accounts.length === 0 ? (
              <li className='px-6 py-4'>
                <NoQuotaNotice />
              </li>
            ) : (
              accounts.map((account) => {
                const label = accountLabel(account, upstreamId)
                const subtitle = accountSubtitle(account, upstreamId)
                return (
                  <li
                    key={`${account.upstreamId}|${account.accountId}`}
                    aria-label={`账号 ${label} 的额度`}
                    className='grid gap-3 py-4'
                  >
                    <div className='grid gap-1 px-6'>
                      <p className='text-sm font-medium'>{label}</p>
                      {subtitle ? (
                        <p className='text-xs text-muted-foreground'>
                          {subtitle}
                        </p>
                      ) : null}
                    </div>
                    <QuotaDetail quota={account} />
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 一个平台的额度还没回来：占着位置，先摆骨架。
 *
 * 只有这一行是骨架，别的平台照常出数。
 */
export function PlatformQuotaSkeleton({
  upstreamId,
  title,
}: {
  upstreamId: string
  /** 行标题：平台的显示名，没有就是 id。 */
  title?: string
}) {
  return (
    <li
      aria-label={`${upstreamId} 额度行 正在读取`}
      aria-busy='true'
      className='rounded-lg border px-4 py-3'
    >
      <div className='grid gap-1'>
        <span className='text-sm font-medium'>
          {title || upstreamId || '未知平台'}
        </span>
        <span className='text-xs text-muted-foreground'>正在读取</span>
      </div>
      <div className='mt-2 h-3 w-40 animate-pulse rounded bg-muted' />
    </li>
  )
}

/** 一个平台的额度没问出来：只有这一行报错，别的平台照常。 */
export function PlatformQuotaError({
  upstreamId,
  title,
  error,
  onRetry,
}: {
  upstreamId: string
  /** 行标题：平台的显示名，没有就是 id。 */
  title?: string
  error: Error
  onRetry: () => void
}) {
  return (
    <li
      aria-label={`${upstreamId} 额度行 没问出来`}
      className='rounded-lg border border-destructive/40'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 px-4 py-3'>
        <div className='grid gap-1'>
          <span className='text-sm font-medium'>
            {title || upstreamId || '未知平台'}
          </span>
          <span className='text-xs text-destructive'>没问出来</span>
        </div>
        <div className='grid justify-items-end gap-2'>
          <span className='text-xs text-muted-foreground'>
            {describeError(error)}
          </span>
          <Button variant='outline' size='sm' onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    </li>
  )
}
