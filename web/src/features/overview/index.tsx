import { Link } from '@tanstack/react-router'
import {
  Activity,
  Boxes,
  CircleDollarSign,
  Clock,
  Layers,
  TriangleAlert,
} from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useBalance } from '@/features/balance/api'
import { useSystemStatus, useUsageSummary } from '@/features/overview/api'
import { formatCount, formatCny, formatUptime } from '@/lib/format'

export function OverviewPage() {
  const status = useSystemStatus()
  const usage = useUsageSummary({ upstreamId: '', window: 'day' })
  const balance = useBalance('')

  if (status.isPending) {
    return <LoadingState />
  }
  if (status.isError) {
    return <ErrorState error={status.error} onRetry={() => status.refetch()} />
  }

  const data = status.data
  const total = usage.data?.total
  const balances = balance.data?.balances ?? []
  const totalAvailable = balances.reduce(
    (sum, item) => sum + item.availableCny,
    0
  )

  return (
    <PageShell
      title='总览'
      description='网关现在的状态：各上游、余额、还有一点用量摘要。'
      actions={
        data.pendingRestart ? (
          <Badge variant='destructive' className='gap-1'>
            <TriangleAlert className='size-3' />
            配置改了还没重启
          </Badge>
        ) : null
      }
    >

      <div className='grid gap-4 lg:grid-cols-4'>
        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Activity className='size-3.5' />
              今日请求
            </CardDescription>
            <CardTitle className='text-2xl'>
              {total ? formatCount(total.requests) : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            {total
              ? `成功 ${formatCount(total.succeeded)} · 失败 ${formatCount(
                  total.failed
                )}`
              : '还没有用量数据'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <CircleDollarSign className='size-3.5' />
              可用余额
            </CardDescription>
            <CardTitle className='text-2xl'>{formatCny(totalAvailable)}</CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            {balances.length > 0
              ? `${balances.length} 笔余额`
              : '上游没有报余额'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Layers className='size-3.5' />
              公布的模型
            </CardDescription>
            <CardTitle className='text-2xl'>{data.publishedModelCount}</CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            <Link to='/models' className='underline underline-offset-4'>
              管理聚合路由
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Clock className='size-3.5' />
              运行时长
            </CardDescription>
            <CardTitle className='text-2xl'>
              {formatUptime(data.uptimeSec)}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            版本 {data.version || '未知'}
          </CardContent>
        </Card>
      </div>

      <Separator className='my-6' />

      <div className='grid gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <Boxes className='size-4' />
              上游
            </CardTitle>
            <CardDescription>
              改开关要重启网关才生效。
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            {data.upstreams.length === 0 ? (
              <EmptyState title='还没有上游' />
            ) : (
              data.upstreams.map((upstream) => (
                <div
                  key={upstream.id}
                  className='flex items-start justify-between gap-3 rounded-lg border p-3'
                >
                  <div className='grid gap-1'>
                    <span className='text-sm font-medium'>
                      {upstream.label || upstream.id}
                    </span>
                    <span className='text-xs text-muted-foreground'>
                      {upstream.id} · {upstream.modelCount} 个模型
                    </span>
                    {upstream.credential ? (
                      <span className='text-xs text-muted-foreground'>
                        凭据 {upstream.credential.kind || '—'}
                      </span>
                    ) : null}
                  </div>
                  <div className='flex shrink-0 flex-col items-end gap-1'>
                    <StatusBadge
                      status={upstream.enabled ? 'enabled' : 'disabled'}
                    />
                    {upstream.credential ? (
                      <StatusBadge status={upstream.credential.status} />
                    ) : null}
                    {upstream.balance ? (
                      <span className='text-xs font-mono'>
                        {formatCny(upstream.balance.availableCny)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <Activity className='size-4' />
              今日用量
            </CardTitle>
            <CardDescription>按上游分。</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            {usage.isPending ? (
              <LoadingState label='正在取用量…' />
            ) : usage.isError ? (
              <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
            ) : (usage.data?.byUpstream.length ?? 0) === 0 ? (
              <EmptyState title='今天还没有请求' />
            ) : (
              usage.data?.byUpstream.map((bucket) => (
                <div
                  key={bucket.key}
                  className='flex items-center justify-between gap-3 rounded-lg border p-3 text-sm'
                >
                  <span className='font-medium'>{bucket.key}</span>
                  <span className='font-mono text-muted-foreground'>
                    {formatCount(bucket.summary?.requests ?? 0n)} 次
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
