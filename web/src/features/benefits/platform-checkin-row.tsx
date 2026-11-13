import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatLocalMoment } from '@/lib/format'
import type { BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'

/** 明细区的 id：展开时 `aria-controls` 指过来。 */
function detailId(upstreamId: string): string {
  return `checkin-detail-${upstreamId}`
}

/**
 * 这一家平台有没有签到结论。
 *
 * 后端给了这家平台的记录，但记录里既没有摘要也没有明细、也没签过时间，
 * 那还是没有结论：有平台 ≠ 有签到记录。
 */
function hasConclusion(benefits: BenefitStatus[] | undefined): boolean {
  if (!benefits) return false
  return benefits.some(
    (benefit) =>
      benefit.summary.trim() || benefit.lines.length > 0 || benefit.checkedAt > 0n,
  )
}

/**
 * 一个平台一行，收起时只给摘要。
 *
 * 行上写平台名、后端给的结论与这次加了多少点；点这一行才展开看逐账号的明细
 * 与签到时刻。默认收起：平台多的时候一屏能看全。
 */
export function PlatformCheckinRow({
  upstreamId,
  title,
  benefits,
  accountAliases,
}: {
  upstreamId: string
  /** 行标题：平台的显示名，没有就是 id。 */
  title: string
  /** 这一家平台的签到结论，一个账号一条；后端没给就是 undefined。 */
  benefits?: BenefitStatus[]
  /** 账号 id → 别名。拿不到别名的账号退回显示 id。 */
  accountAliases: Map<string, string>
}) {
  const [expanded, setExpanded] = useState(false)
  const id = detailId(upstreamId)
  const concluded = hasConclusion(benefits)
  // 平台行的摘要：取第一条有话说的；积分是各账号加起来的。
  const summary =
    benefits?.find((benefit) => benefit.summary.trim())?.summary.trim() ?? ''
  const credits =
    benefits?.reduce((total, benefit) => total + benefit.credits, 0) ?? 0

  return (
    <li aria-label={`${upstreamId} 签到行`} className='rounded-lg border'>
      <button
        type='button'
        aria-label={`${upstreamId} 签到`}
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => setExpanded((open) => !open)}
        className='flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50'
      >
        <span className='grid min-w-0 gap-1'>
          <span className='text-sm font-medium'>{title}</span>
          <span aria-label={`${upstreamId} 签到摘要`} className='text-xs text-muted-foreground'>
            {concluded ? summary || '已签到' : '没有签到记录'}
          </span>
        </span>
        <span className='flex min-w-0 items-center gap-2'>
          {credits > 0 ? <Badge>+{credits} 点</Badge> : null}
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
          aria-label={`${upstreamId} 签到明细`}
          className='grid gap-2 border-t px-6 py-4'
        >
          {!concluded ? (
            <p className='text-sm text-muted-foreground'>没有签到记录</p>
          ) : (
            <>
              {(benefits ?? []).map((benefit) => {
                const label =
                  accountAliases.get(benefit.accountId)?.trim() ||
                  benefit.accountId
                return (
                  <div
                    key={benefit.accountId}
                    aria-label={`${upstreamId} ${label} 签到明细条目`}
                    className='grid gap-0.5 text-sm'
                  >
                    <span className='font-medium'>{label}</span>
                    {benefit.summary.trim() ? (
                      <span className='text-muted-foreground'>
                        {benefit.summary}
                      </span>
                    ) : null}
                    {benefit.lines.length > 0 ? (
                      <ul className='grid gap-0.5 text-muted-foreground'>
                        {benefit.lines.map((line, index) => (
                          <li key={`${index}-${line}`} className='break-words'>
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <span className='text-xs text-muted-foreground'>
                      {benefit.checkedAt > 0n
                        ? `上次签到 ${formatLocalMoment(benefit.checkedAt)}`
                        : '还没签过'}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}
