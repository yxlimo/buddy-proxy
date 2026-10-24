import { useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
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
import {
  useAddProvider,
  useDeleteProvider,
  useProviderKinds,
  useSetUpstreamEnabled,
  useUpdateProvider,
  useUpstreams,
  upstreamKeys,
} from '@/features/upstreams/api'
import { AddProviderDialog } from '@/features/upstreams/add-provider-dialog'
import { ProviderAliasCell } from '@/features/upstreams/provider-alias'
import { QuotaSummary } from '@/features/balance/quota'
import { formatCount } from '@/lib/format'

const REGION_LABELS: Record<string, string> = {
  cn: '中国区',
  global: '海外',
}

export function UpstreamsPage() {
  const upstreams = useUpstreams()
  const kinds = useProviderKinds()
  const setEnabled = useSetUpstreamEnabled()
  const addProvider = useAddProvider()
  const updateProvider = useUpdateProvider()
  const deleteProvider = useDeleteProvider()
  const [adding, setAdding] = useState(false)

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
      title='Provider'
      description='每个 Provider 是一路请求的去处。开关修改后立即生效。'
      actions={
        <Button size='sm' onClick={() => setAdding(true)}>
          <Plus />
          添加
        </Button>
      }
    >

      <Card>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title='网关未返回任何 Provider'
              description='Provider 开关位于本页，无需前往「配置」页。'
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
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
                          {upstream.kind || upstream.label || upstream.id}
                          {/* The alias is how two accounts of the same kind are
                              told apart, so it goes right after the name. */}
                          {upstream.alias ? (
                            <span className='ml-1 text-xs text-muted-foreground'>
                              {upstream.alias}
                            </span>
                          ) : null}
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
                              {upstream.credential.detail || '凭据即将到期'}
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
                      <div className='flex items-center justify-end gap-2'>
                        <ProviderAliasCell
                          providerId={upstream.id}
                          alias={upstream.alias ?? ''}
                          onSave={(alias) =>
                            updateProvider.mutate({ id: upstream.id, alias })
                          }
                        />
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
                        <Button
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`删掉 ${upstream.id}`}
                          disabled={deleteProvider.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `删掉 ${upstream.label || upstream.id}？它名下的凭据也会一起删掉。`
                              )
                            ) {
                              deleteProvider.mutate({ id: upstream.id })
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        kinds={kinds.data?.kinds ?? []}
        pending={addProvider.isPending}
        onSubmit={(input) => {
          addProvider.mutate(input, { onSuccess: () => setAdding(false) })
        }}
      />
    </PageShell>
  )
}
