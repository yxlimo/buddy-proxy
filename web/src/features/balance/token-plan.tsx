import { create } from '@bufbuild/protobuf'
import {
  TokenPlanWindowSchema,
  type TokenPlanWindow,
} from '@/gen/buddy/admin/v1/admin_pb'
import { Progress } from '@/components/ui/progress'
import { formatDateTime } from '@/lib/format'

/** 窗口的名字：general / video。 */
const WINDOW_LABELS: Record<string, string> = {
  general: '通用',
  video: '视频',
}

/** 两个窗口的名字：interval 是 5 小时那个，weekly 是每周那个。 */
export const INTERVAL_WINDOW_LABEL = '5 小时'
export const WEEKLY_WINDOW_LABEL = '每周'

/** 窗口的名字给人看。认不出来就原样显示，不猜。 */
export function windowLabel(label: string): string {
  return WINDOW_LABELS[label] ?? label
}

/** 剩余百分比：越少越红。 */
function percentTone(percent: number): string {
  if (percent <= 10) return 'text-destructive'
  if (percent <= 30) return 'text-amber-600 dark:text-amber-400'
  return 'text-foreground'
}

/**
 * 套餐额度：MiniMax 的 5 小时窗口与周窗口各剩多少。
 *
 * 平台给的是「还剩多少个百分点」，所以 100 是全满。
 */
export function TokenPlanPanel({
  windows,
}: {
  windows: TokenPlanWindow[]
}) {
  if (windows.length === 0) return null

  return (
    <div className='grid gap-4'>
      {windows.map((window, index) => (
        <div
          key={`${window.label}-${index}`}
          className='rounded-lg border p-3'
        >
          <div className='mb-3 flex items-center justify-between gap-2'>
            <span className='text-sm font-medium'>
              {windowLabel(window.label) || '额度窗口'}
            </span>
            <span className='text-xs text-muted-foreground'>
              {window.label || '—'}
            </span>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <QuotaMeter
              title={INTERVAL_WINDOW_LABEL}
              percent={window.intervalPercent}
              endsAt={window.intervalEndsAt}
            />
            <QuotaMeter
              title={WEEKLY_WINDOW_LABEL}
              percent={window.weeklyPercent}
              endsAt={window.weeklyEndsAt}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function QuotaMeter({
  title,
  percent,
  endsAt,
}: {
  title: string
  percent: number
  endsAt: bigint
}) {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div className='grid gap-1.5'>
      <div className='flex items-baseline justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>{title}</span>
        <span className={`font-mono text-sm font-medium ${percentTone(value)}`}>
          剩 {value}%
        </span>
      </div>
      <Progress value={value} />
      <span className='text-xs text-muted-foreground'>
        {endsAt > 0n ? `${formatDateTime(endsAt)} 重置` : '不重置'}
      </span>
    </div>
  )
}

/** 给测试用：造一个窗口。 */
export function makeWindow(
  label: string,
  intervalPercent: number,
  weeklyPercent: number
): TokenPlanWindow {
  return create(TokenPlanWindowSchema, {
    label,
    intervalPercent,
    weeklyPercent,
    intervalEndsAt: 0n,
    weeklyEndsAt: 0n,
  })
}
