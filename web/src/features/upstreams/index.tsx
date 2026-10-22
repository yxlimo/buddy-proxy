import { TriangleAlert } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useSetUpstreamEnabled, useUpstreams } from '@/features/upstreams/api'
import { formatCount } from '@/lib/format'

const REGION_LABELS: Record<string, string> = {
  cn: '中国区',
  global: '海外',
}

export function UpstreamsPage() {
  const upstreams = useUpstreams()
  const setEnabled = useSetUpstreamEnabled()

  // 正在改的是哪一个：用 mutation 的 variables 判断，不用自己存一份
  // busy —— 两个上游一起点的时候，后一个的 finally 会把前一个的 busy
  // 清掉。
  const busyId = setEnabled.isPending ? setEnabled.variables?.upstreamId : null

  if (upstreams.isPending) {
    return <LoadingState />
  }
  if (upstreams.isError) {
    return (
      <ErrorState error={upstreams.error} onRetry={() => upstreams.refetch()} />
    )
  }

  const list = upstreams.data.upstreams

  return (
    <PageShell
      title='上游'
      description='每个上游就是一个模拟的桌面客户端（MiniMax Code、Qoder、WorkBuddy、TokenRhythm）。'
      actions={
        <Badge variant='outline' className='gap-1'>
          <TriangleAlert className='size-3' />
          改了开关要重启网关才生效
        </Badge>
      }
    >

      <Card>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title='网关没有报任何上游'
              description='上游的开关写在配置里，先去「配置」页看一下。'
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>上游</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>凭据</TableHead>
                  <TableHead className='text-right'>模型</TableHead>
                  <TableHead className='text-right'>余额</TableHead>
                  <TableHead className='text-right'>启用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((upstream) => (
                  <TableRow key={upstream.id}>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        <span className='font-medium'>
                          {upstream.label || upstream.id}
                        </span>
                        <span className='text-xs text-muted-foreground'>
                          {upstream.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        {upstream.baseUrl ? (
                          <span className='font-mono text-xs break-all'>
                            {upstream.baseUrl}
                          </span>
                        ) : (
                          <span className='text-xs text-muted-foreground'>—</span>
                        )}
                        {upstream.region ? (
                          <span className='text-xs text-muted-foreground'>
                            {REGION_LABELS[upstream.region] ?? upstream.region}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={upstream.enabled ? 'enabled' : 'disabled'}
                      />
                    </TableCell>
                    <TableCell>
                      {upstream.credential ? (
                        <div className='grid gap-0.5'>
                          <StatusBadge status={upstream.credential.status} />
                          <span className='text-xs text-muted-foreground'>
                            {upstream.credential.kind || '—'}
                            {upstream.credential.fingerprint
                              ? ` · ${upstream.credential.fingerprint}`
                              : ''}
                          </span>
                          {upstream.credential.warning ? (
                            <span className='text-xs text-destructive'>
                              {upstream.credential.detail || '有点问题'}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className='text-muted-foreground'>—</span>
                      )}
                    </TableCell>
                    <TableCell className='text-right font-mono'>
                      {formatCount(upstream.modelCount)}
                    </TableCell>
                    <TableCell className='text-right font-mono'>
                      {upstream.balance
                        ? `¥${upstream.balance.availableCny.toFixed(2)}`
                        : '—'}
                    </TableCell>
                    <TableCell className='text-right'>
                      <Switch
                        checked={upstream.enabled}
                        disabled={busyId === upstream.id}
                        onCheckedChange={(checked) =>
                          setEnabled.mutate({
                            upstreamId: upstream.id,
                            enabled: checked,
                          })
                        }
                        aria-label={`${upstream.label || upstream.id} 的开关`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </PageShell>
  )
}
