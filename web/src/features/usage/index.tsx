import { getRouteApi } from '@tanstack/react-router'
import { PageShell } from '@/components/layout/page-shell'
import {
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUsageSummary } from '@/features/overview/api'
import { useUpstreams } from '@/features/upstreams/api'
import { useUsageEvents } from '@/features/usage/api'
import { UsageTable } from '@/features/usage/usage-table'
import { type NavigateFn } from '@/hooks/use-table-url-state'
import { formatCount } from '@/lib/format'

const route = getRouteApi('/_authenticated/usage')

// 契约里的 ListUsageEvents 只有 limit 和 before_id 游标，所以一次拉一段，
// 翻页在这一段里切。
const EVENTS_LIMIT = 500

// 时间窗。契约里的取值：hour / day / week / month，空表示全部。
// today 是从本地零点算起的一段 —— 早上八点看「今天」，要的是零点到现在。
const WINDOWS = [
  { value: 'today', label: '今日' },
  { value: 'hour', label: '最近一小时' },
  { value: 'day', label: '最近一天' },
  { value: 'week', label: '最近一周' },
  { value: 'month', label: '最近一个月' },
  { value: 'all', label: '全部' },
]

export function UsagePage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()

  const upstreamFilter = search.upstream ?? ''
  const modelFilter = search.model ?? ''
  // 默认看今天：这个页面最常问的是「今天用了多少」。
  const windowFilter = search.window ?? 'today'

  const summary = useUsageSummary({
    upstreamId: upstreamFilter,
    window: windowFilter,
  })
  const upstreams = useUpstreams()
  const events = useUsageEvents({
    upstreamId: upstreamFilter,
    model: modelFilter,
    limit: EVENTS_LIMIT,
    window: windowFilter,
  })

  const total = summary.data?.total
  const upstreamOptions = (upstreams.data?.upstreams ?? []).map((item) => ({
    label: item.label || item.id,
    value: item.id,
  }))
  const modelOptions = (summary.data?.byModel ?? []).map((item) => ({
    label: item.key,
    value: item.key,
  }))

  return (
    <PageShell
      title='用量'
      description='走过的请求：令牌、耗时、明细。记的是真正发到上游的那些请求 —— 模型名写错、在路由就被拒的，不算用量。'
      actions={
        <Select
          value={windowFilter}
          onValueChange={(value) =>
            navigate({
              search: (prev) => ({
                ...prev,
                window: value,
              }),
              replace: true,
            })
          }
        >
          <SelectTrigger className='w-36'>
            <SelectValue placeholder='时间窗' />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {summary.isPending ? (
        <LoadingState label='正在取用量…' />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <>
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <StatCard
              title='请求'
              value={formatCount(total?.requests ?? 0n)}
              hint={`成功 ${formatCount(total?.succeeded ?? 0n)} · 失败 ${formatCount(
                total?.failed ?? 0n
              )}`}
            />
            <StatCard
              title='输入令牌'
              value={formatCount(total?.promptTokens ?? 0n)}
            />
            <StatCard
              title='输出令牌'
              value={formatCount(total?.completionTokens ?? 0n)}
              hint={
                total && total.reasoningTokens > 0n
                  ? `其中推理 ${formatCount(total.reasoningTokens)}`
                  : undefined
              }
            />
            <StatCard
              title='总耗时'
              value={
                total && total.requests > 0n
                  ? `${Math.round(
                      Number(total.latencyMsSum) / Number(total.requests)
                    )} ms`
                  : '—'
              }
              hint='平均每次'
            />
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <BreakdownCard
              title='按上游'
              buckets={summary.data?.byUpstream ?? []}
            />
            <BreakdownCard title='按模型' buckets={summary.data?.byModel ?? []} />
          </div>

          <DaySeries buckets={summary.data?.byDay ?? []} />
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>明细</CardTitle>
          <CardDescription>
            一次拉最近 {EVENTS_LIMIT} 条，在这一段里翻页。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsageTable
            data={events.data?.events ?? []}
            isPending={events.isPending}
            error={events.error}
            onRetry={() => void events.refetch()}
            search={search as Record<string, unknown>}
            navigate={navigate as unknown as NavigateFn}
            upstreamOptions={upstreamOptions}
            modelOptions={modelOptions}
          />
        </CardContent>
      </Card>
    </PageShell>
  )
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string
  value: string
  hint?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className='text-2xl'>{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className='text-sm text-muted-foreground'>{hint}</CardContent>
      ) : null}
    </Card>
  )
}

function BreakdownCard({
  title,
  buckets,
}: {
  title: string
  buckets: {
    key: string
    summary?: {
      requests: bigint
      promptTokens: bigint
      completionTokens: bigint
    }
  }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
      </CardHeader>
      <CardContent className='grid gap-2'>
        {buckets.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            还没有数据。
          </p>
        ) : (
          buckets.map((bucket) => (
            <div
              key={bucket.key}
              className='flex items-center justify-between gap-3 text-sm'
            >
              <span className='truncate font-mono text-xs'>{bucket.key}</span>
              <span className='whitespace-nowrap font-mono text-xs text-muted-foreground'>
                {formatCount(bucket.summary?.requests ?? 0n)} 次 · 入{' '}
                {formatCount(bucket.summary?.promptTokens ?? 0n)} / 出{' '}
                {formatCount(bucket.summary?.completionTokens ?? 0n)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function DaySeries({
  buckets,
}: {
  buckets: { key: string; summary?: { requests: bigint } }[]
}) {
  const max = buckets.reduce(
    (peak, bucket) => Math.max(peak, Number(bucket.summary?.requests ?? 0n)),
    0
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>按天</CardTitle>
        <CardDescription>每天的请求数。</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            还没有数据。
          </p>
        ) : (
          <div className='flex items-end gap-1 overflow-x-auto pb-2'>
            {buckets.map((bucket) => {
              const value = Number(bucket.summary?.requests ?? 0n)
              const height = max > 0 ? Math.max(4, (value / max) * 120) : 4
              return (
                <div
                  key={bucket.key}
                  className='flex min-w-10 flex-col items-center gap-1'
                  title={`${bucket.key}：${value} 次`}
                >
                  <div
                    className='w-full rounded-t bg-primary/70'
                    style={{ height: `${height}px` }}
                  />
                  <span className='text-[10px] text-muted-foreground'>
                    {bucket.key.slice(5)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
