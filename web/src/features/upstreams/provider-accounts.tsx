import { useState } from 'react'
import { KeyRound, LogIn, LogOut, Stethoscope } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  useTestCredential,
} from '@/features/accounts/api'
import { QuotaSummary } from '@/features/balance/quota'
import { formatDateTime } from '@/lib/format'
import type { Account, Credential } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 账号状态的文案。
 *
 * 账号这一层说的是「登录了没有」，凭据那一层说的是「这一条还能不能用」——
 * 同一个状态词，两层的话不一样。
 */
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  usable: '已登录',
  missing: '没有凭据',
  expired: '已过期',
  error: '出错',
}

/** 这个账号现在有没有能用的凭据。没有就登录，有就注销。 */
function isLoggedIn(account: Account): boolean {
  return account.status === 'usable'
}

/**
 * 这条凭据是不是一份不能用了的会话。
 *
 * 只有会话类的凭据要重新授权：key 失效了是换一把 key 的事，重新登录解决不了。
 * 会话是好的（有可用令牌）时也不需要——服务会按自己的节奏换令牌，不等人点。
 */
function isDeadSession(credential: Credential): boolean {
  return credential.kind === 'session' && credential.status !== 'usable'
}

/**
 * 一个 Provider 名下的账号与凭据。
 *
 * 账号按 Provider 分组显示：多数 Provider 一个账号，TokenRhythm 这种多租户
 * 的一个 Provider 几个账号（每个租户一个）。
 */
export function ProviderAccounts({
  providerId,
  kind,
  onLogin,
  onLogout,
  onManageKeys,
  loggingIn,
  loggingOutId,
}: {
  /** 这个上游的唯一 id。 */
  providerId: string
  /** 点「登录」：开一次登录会话。 */
  onLogin: (account: Account) => void
  /** 点「注销」：删掉这个账号名下的凭据。 */
  onLogout: (account: Account) => void
  /** 管理这个上游的 API Key。 */
  onManageKeys: (account: Account) => void
  /** 这个上游是哪一类：不同种类的 key 不一样。 */
  kind: string
  /** 正在发起登录。 */
  loggingIn: boolean
  /** 正在注销的账号。 */
  loggingOutId: string | null
}) {
  const [picked, setPicked] = useState('')
  const accounts = useAccounts()
  // 账号按上游分组：这个上游名下的那些。
  const list = (accounts.data?.accounts ?? []).filter(
    (account) => account.upstreamId === providerId
  )
  // 选中的账号：用户点过的那个；没点过就用第一个 —— 省得先点一下才看到凭据。
  const activeId =
    picked && list.some((account) => account.id === picked)
      ? picked
      : (list[0]?.id ?? '')
  const active = list.find((account) => account.id === activeId)

  const credentials = useCredentials(activeId)
  const testCredential = useTestCredential()

  // 正在动的是哪条凭据：看 mutation 的 variables，不用自己存一份状态。
  const testingId = testCredential.isPending
    ? testCredential.variables?.credentialId
    : undefined

  if (accounts.isPending) {
    return (
      <div className='p-4'>
        <LoadingState />
      </div>
    )
  }
  if (accounts.isError) {
    return (
      <div className='p-4'>
        <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
      </div>
    )
  }
  if (list.length === 0) {
    return (
      <div className='p-4'>
        <EmptyState
          title='这个上游名下没有账号'
          description='账号由网关的登录流程创建。'
        />
      </div>
    )
  }

  return (
    <div className='grid gap-4 p-4'>
      <div className='grid gap-1'>
        <p className='text-sm font-medium'>账号</p>
        <p className='text-xs text-muted-foreground'>
          账号是 Provider 的一个登录身份，凭据挂在账号名下。多数 Provider 一个
          账号，多租户的（TokenRhythm）一个租户一个账号。
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>账号</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className='text-right'>凭据</TableHead>
            <TableHead className='text-right'>额度</TableHead>
            <TableHead className='text-right'>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((account) => {
            const loggedIn = isLoggedIn(account)
            return (
              <TableRow
                key={account.id}
                data-state={activeId === account.id ? 'selected' : undefined}
                className='cursor-pointer'
                onClick={() => setPicked(account.id)}
              >
                <TableCell>
                  <div className='grid gap-0.5'>
                    {/* 账号名是一个真的按钮：光标点得到，键盘也走得到。 */}
                    <Button
                      variant='link'
                      className='h-auto w-fit justify-start p-0 font-medium'
                      aria-current={activeId === account.id ? 'true' : undefined}
                      onClick={(event) => {
                        event.stopPropagation()
                        setPicked(account.id)
                      }}
                    >
                      {account.label || account.id}
                    </Button>
                    <span className='font-mono text-xs text-muted-foreground'>
                      {account.id}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge
                    status={account.status}
                    labels={ACCOUNT_STATUS_LABELS}
                  />
                </TableCell>
                <TableCell className='text-right font-mono'>
                  {account.credentialCount}
                </TableCell>
                <TableCell className='text-right'>
                  {/* 额度分三种：套餐额度、积分、余额。单位不同，
                      不相加，也不换算。 */}
                  <QuotaSummary quota={account.quota} />
                </TableCell>
                <TableCell className='text-right'>
                  <div className='flex justify-end gap-2'>
                    {kind === 'minimax-api' || kind === 'minimax' ? (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={(event) => {
                          event.stopPropagation()
                          onManageKeys(account)
                        }}
                      >
                        <KeyRound />
                        {kind === 'minimax' ? '套餐 key' : 'API Key'}
                      </Button>
                    ) : null}
                    {loggedIn ? (
                      <Button
                        variant='outline'
                        size='sm'
                        disabled={loggingOutId === account.id}
                        onClick={(event) => {
                          // 点注销按钮别顺带把行也选中。
                          event.stopPropagation()
                          onLogout(account)
                        }}
                      >
                        <LogOut />
                        注销
                      </Button>
                    ) : (
                      <Button
                        size='sm'
                        disabled={loggingIn}
                        onClick={(event) => {
                          // 点登录按钮别顺带把行也选中。
                          event.stopPropagation()
                          onLogin(account)
                        }}
                      >
                        <LogIn />
                        登录
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <div className='grid gap-1'>
        <p className='text-sm font-medium'>凭据</p>
        <p className='text-xs text-muted-foreground'>
          {active
            ? `${active.label || active.id} 名下的凭据。只显示掩码和指纹，不给全文。`
            : '在上方选择账号，这里列出它名下的凭据。'}
        </p>
      </div>

      {credentials.isPending ? (
        <LoadingState />
      ) : credentials.isError ? (
        <ErrorState
          error={credentials.error}
          onRetry={() => credentials.refetch()}
        />
      ) : (credentials.data?.credentials.length ?? 0) === 0 ? (
        <EmptyState title='该账号下没有凭据' />
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
            {credentials.data?.credentials.map((credential) => {
              // 这条凭据属于哪个账号：重新登录要走这个账号的登录流程。
              const owner =
                list.find((account) => account.id === credential.accountId) ??
                active
              const deadSession = isDeadSession(credential)
              return (
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
                      {/* 后端说了失效的原因就用它的话；没说的话补一句，
                          免得用户只看到一个「已过期」徽标。 */}
                      {deadSession && !credential.lastError ? (
                        <span className='text-xs text-destructive'>
                          这份会话不能用了，要重新登录
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
                      {/* 会话失效了只能重新授权：走账号那一行现成的登录
                          流程，不另写一套。 */}
                      {deadSession && owner ? (
                        <Button
                          size='sm'
                          disabled={loggingIn}
                          onClick={(event) => {
                            event.stopPropagation()
                            onLogin(owner)
                          }}
                        >
                          <LogIn />
                          重新登录
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
