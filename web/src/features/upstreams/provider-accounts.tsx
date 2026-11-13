import { useState } from 'react'
import { KeyRound, LogIn, Stethoscope, Trash2 } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  useCredentials,
  useTestCredential,
} from '@/features/accounts/api'
import { ProviderAliasCell } from '@/features/upstreams/provider-alias'
import type { ProviderKeyAccess } from '@/features/accounts/provider-key-fields'
import { QuotaSummary } from '@/features/balance/quota'
import { formatDateTime, formatLocalMoment } from '@/lib/format'
import { credentialKindLabel } from '@/lib/credential-kind'
import type { Account, Credential } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 账号状态的文案。
 *
 * 账号这一层说的是「登录了没有」，凭据那一层说的是「这一条还能不能用」—— 同
 * 一个状态词，两层的话不一样。
 */
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  usable: '已登录',
  missing: '没有凭据',
  expired: '已过期',
  error: '出错',
}

/**
 * 这条凭据是不是一份不能用了的会话。
 *
 * 只有会话类的凭据要重新授权：key 失效了是换一把 key 的事，重新登录解决不了。
 * 会话是好的（有可用令牌）时也不需要——服务会按自己的节奏换令牌，不等人点。
 */
function needsRelogin(credential: Credential): boolean {
  return credential.kind === 'session' && credential.status !== 'usable'
}

/**
 * 凭据入口那个按钮写什么。
 *
 * 一格就是一把（标题带「API Key」），几格就是几段（写「凭据」）。格子数还
 * 说不准的时候（开放平台的登记表没到手）一律写「凭据」：此时是几格都不知道。
 */
function accessLabel(access: ProviderKeyAccess): string {
  return access.status === 'ready' && access.layout.fields.length > 1
    ? '凭据'
    : access.status === 'ready'
      ? 'API Key'
      : '凭据'
}

/**
 * 鼠标停在入口上时说的话：为什么现在点不了。
 */
function accessHint(access: ProviderKeyAccess): string | undefined {
  if (access.status === 'loading') {
    return '凭据格子还在加载，稍后再试'
  }
  if (access.status === 'failed') {
    return access.message
  }
  return undefined
}

/**
 * 一个平台名下的账号与凭据。
 *
 * 账号是 provider 表里的一行：同一个平台下可以有好几个（MiniMax Code 的主账号
 * 与 M plan、中转站的每个租户各一行）。列表由平台那一行带下来，这里不再单取一
 * 次账号列表。
 */
export function ProviderAccounts({
  access,
  accounts,
  loggingIn,
  busyAccountId,
  refreshing,
  onLogin,
  onDelete,
  onManageKeys,
  onToggleEnabled,
  onRename,
  onWeightChange,
}: {
  /** 这一类平台的凭据入口：能不能填、不能填的时候为什么（判据在 provider-key-fields 那一层）。 */
  access: ProviderKeyAccess
  /** 这个平台名下的账号，按创建先后排（也就是权重次序）。 */
  accounts: Account[]
  /** 正在发起登录。 */
  loggingIn: boolean
  /** 正在改开关的那个账号。 */
  busyAccountId: string | null
  /** 列表在重取：重取完之前别动开关，免得先弹回旧值再跳到新值。 */
  refreshing: boolean
  /** 点「登录」：开一次登录会话。已有的旧会话由登录覆盖。 */
  onLogin: (account: Account) => void
  /** 点「注销」：删掉这个账号这一行，连同它名下的凭据。 */
  onDelete: (account: Account) => void
  /** 管理这个账号的 API Key。 */
  onManageKeys: (account: Account) => void
  /** 拨开关：开或关这个账号。 */
  onToggleEnabled: (account: Account, enabled: boolean) => void
  /** 改别名。 */
  onRename: (account: Account, alias: string) => void
  /** 改权重：大的先试。 */
  onWeightChange: (account: Account, weight: number) => void
}) {
  const [picked, setPicked] = useState('')
  // 选中的账号：用户点过的那个；没点过就用第一个 —— 省得先点一下才看到凭据。
  const activeId =
    picked && accounts.some((account) => account.id === picked)
      ? picked
      : (accounts[0]?.id ?? '')
  const active = accounts.find((account) => account.id === activeId)

  const credentials = useCredentials(activeId)
  const testCredential = useTestCredential()

  // 给不给「填 key」的入口：这一类平台的凭据有已知的格子（access.status 为
  // ready）。会话型的平台（MiniMax、Qoder、WorkBuddy、ZCode）没有格子，也不给
  // 入口 —— 它们的凭据是登录会话，贴 key 服务端会拒。
  // 格子数还说不准的时候（开放平台的额度插件登记表没到手）入口给出来但是禁用
  // 的：开着它去保存，短掉的那几段会被服务端当成空串清掉。
  const canSetKeys = access.status !== 'none'

  // 正在动的是哪条凭据：看 mutation 的 variables，不用自己存一份状态。
  const testingId = testCredential.isPending
    ? testCredential.variables?.credentialId
    : undefined

  if (accounts.length === 0) {
    return (
      <div>
        <EmptyState
          title='这个平台还没有账号'
          description='点这一行的「新增账号」新增一个，然后在账号那一行登录'
        />
      </div>
    )
  }

  // 外层已经留了边距，这里只管自己内部的排布。
  return (
    <div className='grid gap-4'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>账号</TableHead>
            <TableHead className='text-right'>权重</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className='text-right'>凭据</TableHead>
            <TableHead className='text-right'>额度</TableHead>
            <TableHead className='text-right'>启用</TableHead>
            <TableHead className='text-right'>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
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
                    {account.alias || account.id}
                  </Button>
                  <span className='font-mono text-xs text-muted-foreground'>
                    {account.id}
                  </span>
                </div>
              </TableCell>
              <TableCell className='text-right'>
                {/* 权重：大的先试。降级时按它排先后。 */}
                <Input
                  type='number'
                  className='h-8 w-20 text-right'
                  defaultValue={account.weight}
                  aria-label={`${account.alias || account.id} 的权重`}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    const next = Number(event.target.value)
                    if (!Number.isFinite(next) || next === account.weight) return
                    onWeightChange(account, next)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.currentTarget.blur()
                  }}
                />
              </TableCell>
              <TableCell>
                <div className='grid gap-0.5'>
                  <StatusBadge
                    status={account.status}
                    labels={ACCOUNT_STATUS_LABELS}
                  />
                  {/* 后端说了原因就用它的话：凭据被拒、令牌过期都在这儿。 */}
                  {account.detail ? (
                    <span className='text-xs text-destructive'>
                      {account.detail}
                    </span>
                  ) : null}
                  {/* 路由暂时绕开这个账号：说清楚到什么时候、因为什么。 */}
                  {account.cooldownUntilMs > 0n ? (
                    <span className='text-xs text-muted-foreground'>
                      冷却到 {formatLocalMoment(account.cooldownUntilMs)}
                      {account.cooldownReason
                        ? `（${account.cooldownReason}）`
                        : ''}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className='text-right font-mono'>
                {account.credentialCount}
              </TableCell>
              <TableCell className='text-right'>
                {/* 额度分三种：套餐额度、积分、余额。单位不同，不相加，也不换算。 */}
                <QuotaSummary quota={account.quota} />
              </TableCell>
              <TableCell className='text-right'>
                {/* 开关在这一格自己处理点击：拨开关不该顺带把这一行选中。 */}
                <div
                  className='flex justify-end'
                  onClick={(event) => event.stopPropagation()}
                >
                  <Switch
                    checked={account.enabled}
                    disabled={busyAccountId === account.id || refreshing}
                    onCheckedChange={(checked) =>
                      onToggleEnabled(account, checked)
                    }
                    aria-label={`${account.alias || account.id} 的开关`}
                  />
                </div>
              </TableCell>
              <TableCell className='text-right'>
                <div
                  className='flex items-center justify-end gap-2'
                  onClick={(event) => event.stopPropagation()}
                >
                  {/* 别名是账号自己的：同一个平台下两个账号靠它分辨。这里只给
                      铅笔，名字在左边那一列已经显示了。 */}
                  <ProviderAliasCell
                    providerId={account.id}
                    alias={account.alias ?? ''}
                    iconOnly
                    onSave={(alias) => onRename(account, alias)}
                  />
                  {canSetKeys ? (
                    // 禁用的时候按钮自己收不到鼠标事件（pointer-events: none），
                    // 所以提示挂在外面那个 span 上：鼠标停上去能看出为什么点不了。
                    <span
                      className='inline-flex flex-col items-end gap-0.5'
                      title={accessHint(access)}
                    >
                      <Button
                        variant='outline'
                        size='sm'
                        disabled={access.status !== 'ready'}
                        onClick={() => onManageKeys(account)}
                      >
                        <KeyRound />
                        {accessLabel(access)}
                      </Button>
                      {access.status === 'loading' ? (
                        <span className='text-xs text-muted-foreground'>
                          凭据格子还在加载
                        </span>
                      ) : null}
                      {access.status === 'failed' ? (
                        <span className='max-w-64 text-xs text-destructive'>
                          {access.message}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {/* 登录一直在：登录会覆盖这个账号的旧会话，不需要先注销。 */}
                  <Button
                    size='sm'
                    disabled={loggingIn}
                    onClick={() => onLogin(account)}
                  >
                    <LogIn />
                    登录
                  </Button>
                  {/* 注销 = 删掉这个账号这一行（凭据一起删），要先确认。 */}
                  <Button
                    variant='ghost'
                    size='sm'
                    aria-label={`注销 ${account.alias || account.id}`}
                    onClick={() => onDelete(account)}
                  >
                    <Trash2 />
                    注销
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className='grid gap-1'>
        <p className='text-sm font-medium'>凭据</p>
        <p className='text-xs text-muted-foreground'>
          {active
            ? `${active.alias || active.id} 名下的凭据（只显示掩码和指纹）`
            : '选一个账号，这里列出它名下的凭据'}
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
                accounts.find((account) => account.id === credential.accountId) ??
                active
              const relogin = needsRelogin(credential)
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
                    {/* 类型用中文：协议值（api_key / session / cookie）是后端
                        的枚举，不给操作者看。认不出的值原样显示，好让后端没
                        收敛干净的那条露出来。 */}
                    <Badge variant='outline'>
                      {credentialKindLabel(credential.kind) || '—'}
                    </Badge>
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
                      {/* 后端说了失效的原因就用它的话；没说的话补一句，免得
                          用户只看到一个「已过期」徽标。 */}
                      {relogin && !credential.lastError ? (
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
                      {/* 会话失效了只能重新授权：走账号那一行现成的登录流程，
                          不另写一套。 */}
                      {relogin && owner ? (
                        <Button
                          size='sm'
                          disabled={loggingIn}
                          onClick={() => onLogin(owner)}
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
