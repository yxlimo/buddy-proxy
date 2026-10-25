import type {
  TokenPlanWindow,
  UpstreamQuota,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalanceLotsTable } from '@/features/balance/balance-lots'
import { CreditLotsTable } from '@/features/balance/credit-lots'
import {
  INTERVAL_WINDOW_LABEL,
  TokenPlanPanel,
  WEEKLY_WINDOW_LABEL,
  windowLabel,
} from '@/features/balance/token-plan'
import { formatDate, formatMoney, formatPoints } from '@/lib/format'

/**
 * 三样额度，各是各的。
 *
 *   套餐额度  按窗口的百分比（MiniMax 的 coding plan）。
 *   积分      点数（Qoder、WorkBuddy、SenseNova）。
 *   余额      钱（中转站这类平台）。
 *
 * **不能相加**：单位不同，加出来的数没有意义。
 *
 * 显示的规矩：有套餐额度就显示套餐额度，没有才显示积分；余额有就另外显示。
 */
const QUOTA_LABELS = {
  tokenPlan: '套餐额度',
  credits: '积分',
  balance: '余额',
} as const

type QuotaLine = {
  label: string
  value: string
}

/**
 * 这个额度里有哪几样。
 *
 * 套餐额度优先：它和积分都是「还剩多少」，但单位不一样，不并列显示。
 *
 * 套餐额度的每个窗口各占一行 —— 挤成一行太长，表格里会顶出去。
 */
function quotaLines(quota?: UpstreamQuota): QuotaLine[] {
  if (!quota) return []
  const lines: QuotaLine[] = []

  const windows = quota.tokenPlan?.windows ?? []
  if (windows.length > 0) {
    windows.forEach((window, index) => {
      lines.push({
        label: index === 0 ? QUOTA_LABELS.tokenPlan : '',
        value: tokenPlanLine(window),
      })
    })
  } else if (quota.credits) {
    lines.push({
      label: QUOTA_LABELS.credits,
      value: `剩 ${formatPoints(quota.credits.remaining)} 点`,
    })
  }

  // 余额是另外一样，有就单独显示，不跟上面那行加起来。
  if (quota.balance) {
    lines.push({
      label: QUOTA_LABELS.balance,
      value: formatMoney(
        quota.balance.availableCny,
        quota.balance.currency
      ),
    })
  }

  return lines
}

/** 套餐额度的一个窗口：5 小时窗口和每周窗口各剩多少。 */
function tokenPlanLine(window: TokenPlanWindow): string {
  const name = windowLabel(window.label)
  const parts = [
    `${INTERVAL_WINDOW_LABEL} 剩 ${window.intervalPercent}%`,
    `${WEEKLY_WINDOW_LABEL} 剩 ${window.weeklyPercent}%`,
  ]
  return name ? `${name}：${parts.join(' · ')}` : parts.join(' · ')
}

/**
 * 一行额度摘要。
 *
 * 表格里、上游列表里用这个：每样一行，标上名字，看得出单位不一样。
 *
 * 这里只给一个主额度：有套餐额度就显示套餐额度，没有才显示积分；余额有就
 * 另外一行。三样不叠加、不换算、不求和。
 */
export function QuotaSummary({ quota }: { quota?: UpstreamQuota }) {
  const lines = quotaLines(quota)
  if (lines.length === 0) {
    return <span className='text-xs text-muted-foreground'>—</span>
  }
  return (
    <div className='grid max-w-full gap-0.5'>
      {lines.map((line) => (
        <div
          key={line.label}
          className='flex flex-wrap items-baseline justify-end gap-x-1 text-xs'
        >
          <span className='text-muted-foreground'>{line.label}</span>
          {/* 套餐额度那一行最长，窄列里要能折行，不能溢出到隔壁列去。 */}
          <span className='font-mono break-words' title={line.value}>
            {line.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 账号的额度，按种类分开渲染。
 *
 * 套餐额度给窗口，积分给点数，余额给钱。三段各自独立：不换算，不求和。
 *
 * 有哪样就渲染哪样，各自带自己的名字 —— 点数不会被写成钱，钱也不会被写成
 * 点数。真要有两样同时在（契约上它们是分开的字段），也是两段，不合并。
 */
export function QuotaDetail({ quota }: { quota: UpstreamQuota }) {
  const windows = quota.tokenPlan?.windows ?? []
  const credits = quota.credits
  const balance = quota.balance

  return (
    <div className='grid gap-6 px-6 pb-4'>
      {windows.length > 0 ? (
        <section className='grid gap-2'>
          <p className='text-sm font-medium'>{QUOTA_LABELS.tokenPlan}</p>
          <TokenPlanPanel windows={windows} />
        </section>
      ) : null}

      {credits ? (
        <section className='grid gap-3'>
          <p className='text-sm font-medium'>{QUOTA_LABELS.credits}</p>
          <div className='flex flex-wrap gap-x-6 gap-y-1 text-sm'>
            <span>
              剩余{' '}
              <span className='font-mono'>
                {formatPoints(credits.remaining)} 点
              </span>
            </span>
            {/* 平台没报总额的时候不硬凑：总额和已用都是平台给的说法。 */}
            {credits.total > 0 ? (
              <>
                <span>
                  总额{' '}
                  <span className='font-mono'>
                    {formatPoints(credits.total)} 点
                  </span>
                </span>
                <span>
                  已用{' '}
                  <span className='font-mono'>{formatPoints(credits.used)} 点</span>
                </span>
              </>
            ) : null}
          </div>
          {credits.note ? (
            <p className='text-xs text-muted-foreground'>{credits.note}</p>
          ) : null}
          <CreditLotsTable lots={credits.lots} />
        </section>
      ) : null}

      {balance ? (
        <section className='grid gap-3'>
          <p className='text-sm font-medium'>{QUOTA_LABELS.balance}</p>
          <div className='flex flex-wrap gap-x-6 gap-y-1 text-sm'>
            <span>
              可用{' '}
              <span className='font-mono'>
                {formatMoney(balance.availableCny, balance.currency)}
              </span>
            </span>
            <span>
              最早到期{' '}
              <span className='font-mono'>{formatDate(balance.nextExpiryAt)}</span>
            </span>
            <span>
              会过期的那部分{' '}
              <span className='font-mono'>
                {formatMoney(balance.expiringCny, balance.currency)}
              </span>
            </span>
          </div>
          <BalanceLotsTable lots={balance.lots} />
        </section>
      ) : null}
    </div>
  )
}
