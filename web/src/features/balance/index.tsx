import { PageShell } from '@/components/layout/page-shell'
import { ErrorState, LoadingState } from '@/components/async-state'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useBalance } from '@/features/balance/api'
import { CreditLotsTable } from '@/features/balance/credit-lots'
import { TokenPlanPanel } from '@/features/balance/token-plan'
import { formatCny, formatDate } from '@/lib/format'

export function BalancePage() {
  const balance = useBalance('')

  if (balance.isPending) {
    return <LoadingState />
  }
  if (balance.isError) {
    return (
      <ErrorState error={balance.error} onRetry={() => balance.refetch()} />
    )
  }

  const balances = balance.data.balances

  return (
    <PageShell
      title='余额'
      description='当前可用余额，以及每一笔赠金的明细和到期时间。'
    >

      {balances.length === 0 ? (
        <Card>
          <CardContent className='py-12 text-center text-sm text-muted-foreground'>
            上游没有报余额。
          </CardContent>
        </Card>
      ) : (
        balances.map((summary, index) => (
          <div key={`${summary.upstreamId}-${summary.accountId}-${index}`}>
            <Card className='mb-4'>
              <CardHeader>
                <CardTitle className='text-base'>
                  {summary.currency || 'CNY'} {formatCny(summary.availableCny)}
                </CardTitle>
                <CardDescription>
                  {/* 余额是谁的：契约里 BalanceSummary 带 upstream_id 和
                      account_id，不用靠数组顺序去猜。 */}
                  <span className='font-mono'>
                    {summary.upstreamId || '未知上游'}
                    {summary.accountId ? ` · ${summary.accountId}` : ''}
                  </span>
                  {' · 最早到期的赠金：'}
                  {formatDate(summary.nextExpiryAt)}
                  {summary.expiringCny > 0
                    ? ` · 会过期的那部分 ${formatCny(summary.expiringCny)}`
                    : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className='px-0'>
                {summary.tokenPlan && summary.tokenPlan.windows.length > 0 ? (
                  <div className='border-b px-6 pb-4'>
                    <p className='mb-2 text-sm font-medium'>套餐额度</p>
                    <TokenPlanPanel windows={summary.tokenPlan.windows} />
                  </div>
                ) : null}
                <CreditLotsTable lots={summary.lots} />
              </CardContent>
            </Card>
            <Separator className='mb-4' />
          </div>
        ))
      )}
    </PageShell>
  )
}
