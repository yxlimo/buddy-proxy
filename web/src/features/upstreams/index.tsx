import { Fragment, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { ProviderAccounts } from '@/features/upstreams/provider-accounts'
import { ProviderKeysDialog } from '@/features/accounts/provider-keys-dialog'
import { useLogoutAccount, useSetProviderKeys } from '@/features/accounts/api'
import { useAccountLogin } from '@/features/login/use-account-login'
import { LoginDialog } from '@/features/login/login-dialog'
import { QuotaSummary } from '@/features/balance/quota'
import { formatCount } from '@/lib/format'
import type { Account, Upstream } from '@/gen/buddy/admin/v1/admin_pb'

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
  const logoutAccount = useLogoutAccount()
  const setKeys = useSetProviderKeys()
  const login = useAccountLogin()
  const [adding, setAdding] = useState(false)
  /** 展开着的那个 Provider：点一行看它名下的账号与凭据。 */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 待注销的账号。 */
  const [logoutTarget, setLogoutTarget] = useState<Account | null>(null)
  /** 要删掉的 Provider：null 是没在删。 */
  const [deleteTarget, setDeleteTarget] = useState<Upstream | null>(null)
  /** 正在填 key 的 Provider。 */
  const [keysFor, setKeysFor] = useState<string | null>(null)

  // 正在改的是哪一个：用 mutation 的 variables 判断，不用自己存一份
  // busy —— 两个上游一起点的时候，后一个的 finally 会把前一个的 busy
  // 清掉。
  const busyId = setEnabled.isPending ? setEnabled.variables?.upstreamId : null
  // 列表在重取的时候开关别动：开关的值以服务端的答复为准，重取完了再让它
  // 变，免得先弹回旧值再跳到新值。
  const refreshing = useIsFetching({ queryKey: upstreamKeys.all }) > 0
  // 正在注销的账号：一个账号一次注销。
  const loggingOutId = logoutAccount.isPending
    ? (logoutAccount.variables?.accountId ?? null)
    : null

  if (upstreams.isPending) {
    return <LoadingState />
  }
  if (upstreams.isError) {
    return (
      <ErrorState error={upstreams.error} onRetry={() => upstreams.refetch()} />
    )
  }

  const list = upstreams.data.upstreams
  const loginTarget = login.target

  return (
    <PageShell
      title='Provider'
      description='每个 Provider 是一路请求的去处。点一行看它名下的账号与凭据。开关修改后立即生效。'
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
                {list.map((upstream) => {
                  const isExpanded = expanded === upstream.id
                  return (
                    <Fragment key={upstream.id}>
                      <TableRow
                        data-state={isExpanded ? 'selected' : undefined}
                        className='cursor-pointer'
                        onClick={() =>
                          setExpanded(isExpanded ? null : upstream.id)
                        }
                      >
                        <TableCell>
                          <div className='flex items-start gap-1.5'>
                            <Button
                              variant='ghost'
                              size='icon-sm'
                              aria-expanded={isExpanded}
                              aria-label={`${
                                isExpanded ? '收起' : '展开'
                              } ${upstream.id} 的账号与凭据`}
                              onClick={(event) => {
                                event.stopPropagation()
                                setExpanded(isExpanded ? null : upstream.id)
                              }}
                            >
                              <ChevronRight
                                className={`transition-transform ${
                                  isExpanded ? 'rotate-90' : ''
                                }`}
                              />
                            </Button>
                            <div className='grid gap-0.5'>
                              {/* The name the user gave it. Two accounts of the same
                                  kind are told apart by it. */}
                              <span className='font-medium'>
                                {upstream.alias || upstream.label || upstream.id}
                              </span>
                              {/* The unique id: the path segment clients use, and
                                  the key the provider has in the agent clients. */}
                              <span className='font-mono text-xs text-muted-foreground'>
                                {upstream.id}
                              </span>
                            </div>
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
                          {/* 这一格里的东西自己处理点击：点开关、点别名、
                              点删除都不该顺带把这一行展开。 */}
                          <div
                            className='flex items-center justify-end gap-2'
                            onClick={(event) => event.stopPropagation()}
                          >
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
                              onClick={() => setDeleteTarget(upstream)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded ? (
                        <TableRow>
                          <TableCell colSpan={7} className='bg-muted/30 p-0'>
                            <ProviderAccounts
                              providerId={upstream.id}
                              loggingIn={login.pending}
                              loggingOutId={loggingOutId}
                              onLogin={(account) =>
                                login.start({
                                  upstreamId: account.upstreamId,
                                  id: account.id,
                                  label: account.label || account.id,
                                })
                              }
                              onLogout={(account) => setLogoutTarget(account)}
                              onManageKeys={(account) =>
                                setKeysFor(account.upstreamId)
                              }
                            />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  )
                })}
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

      <LoginDialog
        open={loginTarget !== null || login.loginId !== ''}
        loginId={login.loginId}
        upstreamId={loginTarget?.upstreamId}
        accountId={loginTarget?.accountId}
        accountLabel={loginTarget?.label}
        onOpenChange={(open) => {
          if (open) return
          login.close()
        }}
        onRestart={
          loginTarget
            ? () =>
                login.start({
                  upstreamId: loginTarget.upstreamId,
                  id: loginTarget.accountId,
                  label: loginTarget.label,
                })
            : undefined
        }
      />

      <ProviderKeysDialog
        open={keysFor !== null}
        onOpenChange={(open) => {
          if (!open) setKeysFor(null)
        }}
        existing={[]}
        pending={setKeys.isPending}
        onSubmit={(keys) => {
          setKeys.mutate(
            { upstreamId: keysFor ?? 'minimax-api', keys },
            {
              onSuccess: () => setKeysFor(null),
            }
          )
        }}
      />

      {/* 注销要确认：凭据删掉就回不来了。 */}
      <AlertDialog
        open={logoutTarget !== null}
        onOpenChange={(open) => {
          if (!open) setLogoutTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              注销 {logoutTarget ? logoutTarget.label || logoutTarget.id : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              这个账号名下的凭据会全部删掉（{logoutTarget?.credentialCount ?? 0}{' '}
              条）。删掉之后它回到「没有凭据」，要重新登录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const target = logoutTarget
                setLogoutTarget(null)
                if (!target) return
                logoutAccount.mutate({ accountId: target.id })
              }}
            >
              注销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删 Provider 也要确认：凭据跟着一起删掉。 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删掉 {deleteTarget ? deleteTarget.alias || deleteTarget.label || deleteTarget.id : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              这个 Provider 会被删掉，它名下的凭据也会一起删掉。删掉之后客户端要用新的
              路径（/{deleteTarget?.id ?? ''}/v1）才能访问它。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (!target) return
                deleteProvider.mutate({ id: target.id })
              }}
            >
              删掉
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}
