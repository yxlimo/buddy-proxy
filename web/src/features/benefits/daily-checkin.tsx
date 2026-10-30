import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useBenefitStatus, useRunBenefitNow } from '@/features/upstreams/benefits'
import { formatLocalMoment } from '@/lib/format'

/**
 * 每日签到统一区。
 *
 * 签到状态是后端给的一份：哪个账号签过、加了多少点、什么时候签的，面板原样
 * 显示，不自己算「今天签没签」。多个平台的账号混在一张表里，因为签到这件事
 * 对面板来说是同一件事。
 */
export function DailyCheckinPanel() {
  const status = useBenefitStatus()
  const run = useRunBenefitNow()
  const benefits = status.data?.benefits ?? []

  // 没有登记签到的账号：整块不出现，别占位置。
  if (benefits.length === 0) return null

  const lines = run.data?.lines ?? []

  return (
    <Card>
      <CardHeader>
        <div className='flex items-start justify-between gap-3'>
          <div className='grid gap-1'>
            <CardTitle>每日签到</CardTitle>
            <CardDescription>各账号最近一次签到加了多少积分</CardDescription>
          </div>
          <Button
            size='sm'
            onClick={() => run.mutate()}
            disabled={run.isPending}
          >
            {run.isPending ? '签到中…' : '现在签到'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className='grid gap-3'>
        {benefits.map((benefit) => (
          <div
            key={benefit.upstreamId}
            className='grid gap-1 rounded-lg border p-3'
          >
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm font-medium'>{benefit.upstreamId}</span>
              <div className='flex items-center gap-2'>
                {benefit.credits > 0 ? (
                  <Badge>+{benefit.credits} 点</Badge>
                ) : null}
                {/* ok 说的是「上次签到成不成功」。从来没签过时后端也给
                    ok=false，那不是失败，只是没有记录：没有记录就不标失败。 */}
                {!benefit.ok && benefit.checkedAt > 0n ? (
                  <span className='text-xs text-muted-foreground'>未成功</span>
                ) : null}
              </div>
            </div>
            {benefit.checkedAt > 0n ? (
              <span className='text-xs text-muted-foreground'>
                上次签到 {formatLocalMoment(benefit.checkedAt)}
              </span>
            ) : (
              <span className='text-xs text-muted-foreground'>还没签过</span>
            )}
            {benefit.summary ? (
              <span className='text-sm text-muted-foreground'>
                {benefit.summary}
              </span>
            ) : null}
            {benefit.lines.length > 0 ? (
              <ul className='grid gap-0.5 text-xs text-muted-foreground'>
                {benefit.lines.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}

        {run.data ? (
          <div className='grid gap-1 rounded-lg border p-3'>
            <span className='text-sm font-medium'>本次签到</span>
            {lines.length > 0 ? (
              <ul className='grid gap-0.5 text-xs text-muted-foreground'>
                {lines.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            ) : (
              <span className='text-xs text-muted-foreground'>没有输出</span>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
