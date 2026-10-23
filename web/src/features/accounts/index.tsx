import { useState } from 'react'
import { LogIn, RefreshCw, Stethoscope } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useAccounts,
  useCredentials,
  useRefreshCredential,
  useTestCredential,
} from '@/features/accounts/api'
import { useBeginLogin } from '@/features/login/api'
import { useLoginIdInHash } from '@/features/login/hash'
import { LoginDialog } from '@/features/login/login-dialog'
import { QuotaSummary } from '@/features/balance/quota'
import { formatDateTime } from '@/lib/format'

export function AccountsPage() {
  const accounts = useAccounts()
  const [selected, setSelected] = useState<string>('')
  const credentials = useCredentials(selected)
  const testCredential = useTestCredential()
  const refreshCredential = useRefreshCredential()

  // 没走完的登录放在 URL 的 hash 里：刷新页面还能接上。
  const [loginId, setLoginId] = useLoginIdInHash()
  const [loginTarget, setLoginTarget] = useState<{
    upstreamId: string
    accountId: string
    label: string
  } | null>(null)
  const beginLogin = useBeginLogin()

  // 正在动的是哪条凭据：看 mutation 的 variables，不用自己存一份状态
  // （两个按钮连点的时候自己那份会串）。
  const testingId = testCredential.isPending
    ? testCredential.variables?.credentialId
    : undefined
  const refreshingId = refreshCredential.isPending
    ? refreshCredential.variables?.credentialId
    : undefined

  /** 点「登录」：开一次会话，把 login_id 写进 hash。 */
  const startLogin = (account: {
    upstreamId: string
    id: string
    label: string
  }) => {
    setLoginTarget({
      upstreamId: account.upstreamId,
      accountId: account.id,
      label: account.label || account.id,
    })
    beginLogin.mutate(
      { upstreamId: account.upstreamId, accountId: account.id },
      {
        onSuccess: (session) => {
          if (!session) {
            setLoginTarget(null)
            return
          }
          setLoginId(session.loginId)
        },
        onError: () => {
          setLoginTarget(null)
        },
      }
    )
  }

  if (accounts.isPending) {
    return <LoadingState />
  }
  if (accounts.isError) {
    return (
      <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
    )
  }

  const list = accounts.data.accounts

  return (
    <PageShell
      title='账号与凭据'
      description='账号是上游的一个登录身份，凭据挂在账号下面（refresh token、API key、cookie 之类）。'
    >

      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>账号</CardTitle>
          <CardDescription>点账号名看它名下的凭据。没凭据的账号要点「登录」去授权。</CardDescription>
        </CardHeader>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState title='网关没有报任何账号' />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>上游</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className='text-right'>凭据</TableHead>
                  <TableHead className='text-right'>额度</TableHead>
                  <TableHead className='text-right'>详情</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((account) => {
                  // 没有凭据的账号：登录按钮给它点，别让它淹没在一堆「可用」里。
                  const withoutCredential =
                    account.credentialCount === 0 ||
                    account.status === 'missing' ||
                    account.status === 'expired'
                  return (
                    <TableRow
                      key={account.id}
                      data-state={selected === account.id ? 'selected' : undefined}
                      className='cursor-pointer'
                      onClick={() => setSelected(account.id)}
                    >
                      <TableCell>
                        <div className='grid gap-0.5'>
                          {/* 账号名是一个真的按钮：光标点得到，键盘也走得到。 */}
                          <Button
                            variant='link'
                            className='h-auto w-fit justify-start p-0 font-medium'
                            aria-current={selected === account.id ? 'true' : undefined}
                            onClick={() => setSelected(account.id)}
                          >
                            {account.label || account.id}
                          </Button>
                          <span className='font-mono text-xs text-muted-foreground'>
                            {account.id}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className='text-xs'>{account.upstreamId}</span>
                      </TableCell>
                      <TableCell>
                        <div className='grid gap-0.5'>
                          <StatusBadge status={account.status} />
                          {withoutCredential ? (
                            <span className='text-xs text-muted-foreground'>
                              没有凭据，登录一下
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className='text-right font-mono'>
                        {account.credentialCount}
                      </TableCell>
                      <TableCell className='text-right'>
                        {/* 额度分三种：套餐额度、积分、余额。单位不同，
                            不相加，也不换算。 */}
                        <QuotaSummary quota={account.quota} />
                      </TableCell>
                      <TableCell className='text-right text-xs text-muted-foreground'>
                        {account.detail || '—'}
                      </TableCell>
                      <TableCell className='text-right'>
                        <Button
                          variant={withoutCredential ? 'default' : 'outline'}
                          size='sm'
                          disabled={beginLogin.isPending}
                          onClick={(event) => {
                            // 点登录按钮别顺带把行也选中。
                            event.stopPropagation()
                            startLogin({
                              upstreamId: account.upstreamId,
                              id: account.id,
                              label: account.label || account.id,
                            })
                          }}
                        >
                          <LogIn />
                          登录
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>凭据</CardTitle>
          <CardDescription>
            {selected
              ? `只显示掩码和指纹，不给全文。`
              : '上面选一个账号，这里列它的凭据。'}
          </CardDescription>
        </CardHeader>
        <CardContent className='px-0'>
          {!selected ? (
            <EmptyState title='还没选账号' />
          ) : credentials.isPending ? (
            <LoadingState />
          ) : credentials.isError ? (
            <ErrorState
              error={credentials.error}
              onRetry={() => credentials.refetch()}
            />
          ) : (credentials.data?.credentials.length ?? 0) === 0 ? (
            <EmptyState title='这个账号名下没有凭据' />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>凭据</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>掩码</TableHead>
                  <TableHead>指纹</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.data?.credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        <span className='font-medium'>
                          {credential.label || credential.id}
                        </span>
                        <span className='font-mono text-xs text-muted-foreground'>
                          {credential.id}
                          {credential.generation > 0
                            ? ` · 第 ${credential.generation} 代`
                            : ''}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant='outline'>{credential.kind || '—'}</Badge>
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {credential.masked || '—'}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {credential.fingerprint || '—'}
                    </TableCell>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        <StatusBadge status={credential.status} />
                        {credential.lastError ? (
                          <span className='text-xs text-destructive'>
                            {credential.lastError}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className='text-xs'>
                      {formatDateTime(credential.expiresAt)}
                      {credential.lastOkAt ? (
                        <div className='text-muted-foreground'>
                          最近可用 {formatDateTime(credential.lastOkAt)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={testingId === credential.id}
                          onClick={() =>
                            testCredential.mutate({ credentialId: credential.id })
                          }
                        >
                          <Stethoscope />
                          试一下
                        </Button>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={refreshingId === credential.id}
                          onClick={() =>
                            refreshCredential.mutate({
                              credentialId: credential.id,
                            })
                          }
                        >
                          <RefreshCw />
                          强制刷新
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

      <LoginDialog
        open={loginTarget !== null || loginId !== ''}
        loginId={loginId}
        upstreamId={loginTarget?.upstreamId}
        accountId={loginTarget?.accountId}
        accountLabel={loginTarget?.label}
        onOpenChange={(open) => {
          if (open) return
          setLoginTarget(null)
          // 登录没了就把 hash 里的 login_id 也清掉，别留个接不上的会话。
          setLoginId('')
        }}
        onRestart={
          loginTarget
            ? () =>
                startLogin({
                  upstreamId: loginTarget.upstreamId,
                  id: loginTarget.accountId,
                  label: loginTarget.label,
                })
            : undefined
        }
      />
    </PageShell>
  )
}
