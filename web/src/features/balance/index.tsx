import { RefreshCw } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState, LoadingState } from '@/components/async-state'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useBalance, useRefreshBalance } from '@/features/balance/api'
import { QuotaDetail } from '@/features/balance/quota'

export function BalancePage() {
  const balance = useBalance('')
  const refresh = useRefreshBalance('')

  if (balance.isPending) {
    return <LoadingState />
  }
  if (balance.isError) {
    return (
      <ErrorState error={balance.error} onRetry={() => balance.refetch()} />
    )
  }

  const quotas = balance.data.quotas

  return (
    <PageShell
      title='额度'
      description='各账号的额度。余额、积分与套餐额度分别列示。'
      actions={
        <Button
          variant='outline'
          size='sm'
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'}
          />
          {refresh.isPending ? '正在刷新…' : '刷新额度'}
        </Button>
      }
    >

      {quotas.length === 0 ? (
        <Card>
          <CardContent className='py-12 text-center text-sm text-muted-foreground'>
            Provider 没有报额度。
          </CardContent>
        </Card>
      ) : (
        quotas.map((quota, index) => (
          <div key={`${quota.upstreamId}-${quota.accountId}-${index}`}>
            <Card className='mb-4'>
              <CardHeader>
                <CardTitle className='text-base'>
                  {quota.upstreamId || '未知 Provider'}
                  {quota.accountId ? ` · ${quota.accountId}` : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className='px-0'>
                <QuotaDetail quota={quota} />
              </CardContent>
            </Card>
            <Separator className='mb-4' />
          </div>
        ))
      )}
    </PageShell>
  )
}
