import { CalendarCheck, Loader2 } from 'lucide-react'
import { ErrorState, LoadingState } from '@/components/async-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLocalMoment } from '@/lib/format'
import type {
  Account,
  BenefitStatus,
  RunBenefitNowResponse,
} from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 一个平台的每日签到。
 *
 * 签到是账号的事：这个平台名下的账号里，只有登记了签到的才出现在这里。没有
 * 登记签到的平台（SenseNova、TokenRhythm 这些）整块都不显示。
 *
 * 状态与说明都是后端给的：summary 说什么就是什么，ok 决定要不要标成失败，
 * 面板不自己推断今天签没签。
 */
export function BenefitsPanel({
  accounts,
  benefits,
  loading,
  error,
  running,
  runResult,
  onRun,
  onRetry,
}: {
  /** 这个平台名下的账号。 */
  accounts: Account[]
  /** 后端给的全部签到状态（所有账号的，不分平台）。 */
  benefits: BenefitStatus[]
  /** 状态还在取。 */
  loading: boolean
  /** 状态取不到。 */
  error: unknown
  /** 签到正在跑。 */
  running: boolean
  /** 刚才那次签到的结果。 */
  runResult: RunBenefitNowResponse | null
  /** 点「现在签到」。 */
  onRun: () => void
  /** 状态取不到时重试。 */
  onRetry: () => void
}) {
  // 签到状态按账号 id 归到平台名下：benefit 里的 upstreamId 是账号 id，
  // 跟平台 id 不是一回事。
  const accountIds = new Set(accounts.map((account) => account.id))
  const rows = benefits.filter((benefit) => accountIds.has(benefit.upstreamId))

  // 这个平台没有账号登记签到：整块不显示。
  if (!loading && !error && rows.length === 0) {
    return null
  }

  return (
    <section className='grid gap-3' aria-label='每日签到'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='grid gap-0.5'>
          <h3 className='text-sm font-medium'>每日签到</h3>
          <p className='text-xs text-muted-foreground'>
            登记了签到的账号每天一次。点「现在签到」会把所有登记过的账号都签
            一遍，所以下面结果是全部账号的
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          disabled={running}
          onClick={onRun}
        >
          {running ? (
            <Loader2 className='animate-spin' />
          ) : (
            <CalendarCheck />
          )}
          {running ? '签到中' : '现在签到'}
        </Button>
      </div>

      {/* 刚才那次签到的结果：成功失败都逐行给出来，失败时不说「失败」了事。 */}
      {runResult && runResult.lines.length > 0 ? (
        <div className='grid gap-1 rounded-md border p-3'>
          <p
            className={`text-xs font-medium ${
              runResult.ok ? '' : 'text-destructive'
            }`}
          >
            {runResult.ok ? '本次签到' : '本次签到（有账号没成功）'}
          </p>
          {runResult.lines.map((line, index) => (
            <p key={index} className='text-xs text-muted-foreground'>
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {loading ? (
        <LoadingState label='正在取签到状态…' />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        rows.map((benefit) => {
          const account = accounts.find(
            (row) => row.id === benefit.upstreamId
          )
          const name = account?.alias || benefit.upstreamId
          // ok 说的是「上次签到成不成功」。从来没签过时后端也给 ok=false，
          // 那不是失败，只是没有记录：没有记录就不标失败。
          const failed = !benefit.ok && benefit.checkedAt > 0n
          return (
            <div
              key={benefit.upstreamId}
              className='grid gap-1 rounded-md border p-3'
            >
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <div className='grid gap-0.5'>
                  <span className='text-sm font-medium'>{name}</span>
                  <span className='font-mono text-xs text-muted-foreground'>
                    {benefit.upstreamId}
                  </span>
                </div>
                <div className='flex items-center gap-2'>
                  {failed ? (
                    <Badge variant='destructive'>未成功</Badge>
                  ) : null}
                  <span className='text-xs text-muted-foreground'>
                    {benefit.checkedAt > 0n
                      ? formatLocalMoment(benefit.checkedAt)
                      : '还没签过'}
                  </span>
                </div>
              </div>
              <p className={failed ? 'text-sm text-destructive' : 'text-sm'}>
                {benefit.summary}
              </p>
              {benefit.credits > 0 ? (
                <p className='text-xs'>+{benefit.credits} 点</p>
              ) : null}
              {benefit.lines.map((line, index) => (
                <p key={index} className='text-xs text-muted-foreground'>
                  {line}
                </p>
              ))}
            </div>
          )
        })
      )}
    </section>
  )
}
