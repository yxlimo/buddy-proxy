import { useIsFetching } from '@tanstack/react-query'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import {
  CredentialStateBadge,
  UpstreamStateBadge,
} from '@/features/upstreams/state-badge'
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
import { useSetUpstreamEnabled, useUpstreams, upstreamKeys } from '@/features/upstreams/api'
import { QuotaSummary } from '@/features/balance/quota'
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
  // 列表在重取的时候开关别动：开关的值以服务端的答复为准，重取完了再让它
  // 变，免得先弹回旧值再跳到新值。
  const refreshing = useIsFetching({ queryKey: upstreamKeys.all }) > 0

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
      description='每个上游对应一个模拟的桌面客户端（MiniMax Code、Qoder、WorkBuddy、TokenRhythm 等）。开关修改后立即生效。'
    >

      <Card>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title='网关未返回任何上游'
              description='上游开关位于本页，无需前往「配置」页。'
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
                  <TableHead className='text-right'>额度</TableHead>
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
                    <TableCell className='max-w-[16rem]'>
                      {/* min-w-0：网格项默认不肯比容器窄，长地址会顶到隔壁列上去。 */}
                      <div className='grid min-w-0 gap-0.5'>
                        {upstream.baseUrl ? (
                          <span
                            className='font-mono text-xs break-all whitespace-normal'
                            title={upstream.baseUrl}
                          >
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
                      <UpstreamStateBadge state={upstream.state} />
                    </TableCell>
                    <TableCell>
                      {upstream.credential ? (
                        <div className='grid gap-0.5'>
                          <CredentialStateBadge status={upstream.credential.status} />
                          <span className='text-xs text-muted-foreground'>
                            {upstream.credential.kind || '—'}
                            {upstream.credential.fingerprint
                              ? ` · ${upstream.credential.fingerprint}`
                              : ''}
                          </span>
                          {upstream.credential.warning ? (
                            <span className='text-xs text-destructive'>
                              {upstream.credential.detail || '状态异常'}
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
                    <TableCell className='max-w-[18rem] text-right'>
                      {/* 额度有三样，单位和单位都不一样：有套餐额度就显示
                          套餐额度，没有才显示积分，余额另外显示。不相加。 */}
                      <QuotaSummary quota={upstream.quota} />
                    </TableCell>
                    <TableCell className='text-right'>
                      <Switch
                        checked={upstream.enabled}
                        disabled={busyId === upstream.id || refreshing}
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
