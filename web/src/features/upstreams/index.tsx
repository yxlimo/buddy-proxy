import { Fragment, useMemo, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronRight, GripVertical, Plus } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { UpstreamStateBadge } from '@/features/upstreams/state-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  upstreamKeys,
  useAddAccount,
  useDeleteAccount,
  useSetAccountEnabled,
  useProviderKinds,
  useUpstreams,
  useUpdateProvider,
} from '@/features/upstreams/api'
import { AddAccountDialog } from '@/features/upstreams/add-account-dialog'
import {
  useAddPlatform,
  useListPlatformKinds,
  useQuotaPlugins,
  useRefreshPlatformModels,
  useUpdatePlatform,
} from '@/features/open-platforms/api'
import {
  platformKindsFrom,
  refreshModelsControl,
} from '@/features/open-platforms/platform-kinds'
import { DeletePlatformButton } from '@/features/open-platforms/platform-delete'
import {
  OpenPlatformFacts,
  type RefreshOutcome,
} from '@/features/open-platforms/platform-facts'
import { PlatformDialog } from '@/features/open-platforms/platform-dialog'
import { PlatformModelsButton } from '@/features/open-platforms/models-dialog'
import { useBenefitStatus, useRunBenefitNow } from '@/features/upstreams/benefits'
import { BenefitsPanel } from '@/features/upstreams/benefits-panel'
import { ProviderAccounts } from '@/features/upstreams/provider-accounts'
import { ProviderPolicySelect } from '@/features/upstreams/provider-policy'
import { ProviderKeysDialog } from '@/features/accounts/provider-keys-dialog'
import {
  providerKeyAccess,
  providerKindsFrom,
  quotaRegistryFrom,
} from '@/features/accounts/provider-key-fields'
import { useSetProviderKeys } from '@/features/accounts/api'
import { formatLocalMoment } from '@/lib/format'
import { describeError } from '@/lib/errors'
import {
  movePlatformOrder,
  useOrderedPlatforms,
  writePlatformOrder,
} from '@/lib/platform-order'
import { useAccountLogin } from '@/features/login/use-account-login'
import { LoginDialog } from '@/features/login/login-dialog'
import type {
  Account,
  RunBenefitNowResponse,
  Upstream,
} from '@/gen/buddy/admin/v1/admin_pb'

const REGION_LABELS: Record<string, string> = {
  cn: '中国区',
  global: '海外',
}

/**
 * 上游页：平台列表 + 账号管理。
 *
 * 平台是表里的行（播种的模拟客户端与自建的开放平台都是），它的 id 是请求路径
 * 里那一段：名字改得了、平台删得掉，id 改不了。能改的还有生效策略。账号是 provider
 * 表里的行：一个平台下可以有好几个，各自的凭据、开关、额度各归各。
 */
export function UpstreamsPage() {
  const upstreams = useUpstreams()
  const setEnabled = useSetAccountEnabled()
  const addAccount = useAddAccount()
  const updateProvider = useUpdateProvider()
  const deleteAccount = useDeleteAccount()
  const setKeys = useSetProviderKeys()
  const login = useAccountLogin()
  // 开放平台：面板上加的那些平台（表里的行），跟播种的模拟客户端不是一回事。
  const plugins = useQuotaPlugins()
  // 账号类型那一份：填凭据那几格由它说（面板不留自己那张按 kind 查的表）。
  const providerKindsQuery = useProviderKinds()
  const kindsQuery = useListPlatformKinds()
  const addPlatform = useAddPlatform()
  const updatePlatform = useUpdatePlatform()
  const refreshModels = useRefreshPlatformModels()
  /** 展开着的那个平台：点一行看它名下的账号与凭据。 */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 正在给哪个平台新增账号。 */
  const [adding, setAdding] = useState<Upstream | null>(null)
  /** 待注销的账号：删这一行连同它的凭据。 */
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)
  /** 正在填 key 的账号 id。 */
  const [keysFor, setKeysFor] = useState<string | null>(null)
  /** 正在新增平台（表里的那一行）。 */
  const [addingPlatform, setAddingPlatform] = useState(false)
  /** 正在改的平台。 */
  const [editingPlatform, setEditingPlatform] = useState<Upstream | null>(null)
  /** 上一次刷新模型目录的结果：按平台记着，照服务端的话显示。 */
  const [refreshOutcomes, setRefreshOutcomes] = useState<Record<string, RefreshOutcome>>({})
  /** 排序模式：只在这个模式下能拖行，退出后行回到原来的用法。 */
  const [sorting, setSorting] = useState(false)

  /** 打开弹窗：把上一次提交留下的错误清掉，别让新的表单接着显示旧话。 */
  const openAddPlatform = () => {
    addPlatform.reset()
    updatePlatform.reset()
    setAddingPlatform(true)
  }
  const openEditPlatform = (upstream: Upstream) => {
    addPlatform.reset()
    updatePlatform.reset()
    setEditingPlatform(upstream)
  }
  /** 刚才那次签到的结果：签到是全局的，结果留在页面上，换个平台也还在。 */
  const [runResult, setRunResult] = useState<RunBenefitNowResponse | null>(null)
  // 签到状态是所有账号一份的：展开了才去取，没展开不费那个请求。
  const benefits = useBenefitStatus({ enabled: expanded !== null })
  const runBenefit = useRunBenefitNow()

  // 正在改的是哪一个：用 mutation 的 variables 判断，不用自己存一份 busy ——
  // 两个账号一起点的时候，后一个的 finally 会把前一个的 busy 清掉。
  const busyAccountId = setEnabled.isPending
    ? (setEnabled.variables?.accountId ?? null)
    : null
  // 列表在重取的时候开关别动：开关的值以服务端的答复为准，重取完了再让它变，
  // 免得先弹回旧值再跳到新值。
  const refreshing = useIsFetching({ queryKey: upstreamKeys.all }) > 0
  // 建平台时能选的类型：名字那一行（`platformKindReadout`）收在
  // platform-kinds.ts，这里只照结果渲染。用 useMemo 稳住这一份：弹窗里那个
  // 「清单到手了选第一条」的 effect 拿它当依赖，每次渲染新建一个就会白跑一次。
  // 得摆在下面那两个提前 return 之前：hook 不能只在有数据的时候调。
  const kinds = useMemo(
    () =>
      platformKindsFrom({
        isPending: kindsQuery.isPending,
        isError: kindsQuery.isError,
        error: kindsQuery.error,
        kinds: kindsQuery.data?.kinds,
      }),
    [
      kindsQuery.isPending,
      kindsQuery.isError,
      kindsQuery.error,
      kindsQuery.data,
    ]
  )

  // 平台列表：次序照操作者自己排的那一份（存在浏览器里），服务端次序作后备。
  // 用 useMemo 稳住这份清单：重排拿它当依赖，每次渲染新建一份会白排一次。
  const platforms = useMemo(
    () => upstreams.data?.upstreams ?? [],
    [upstreams.data]
  )
  const list = useOrderedPlatforms(platforms)

  if (upstreams.isPending) {
    return <LoadingState />
  }
  if (upstreams.isError) {
    return (
      <ErrorState error={upstreams.error} onRetry={() => upstreams.refetch()} />
    )
  }

  const loginTarget = login.target
  // 额度插件登记表的状态：三档（加载中 / 取不到 / 到手）。开放平台的凭据格子
  // 数由它说了算，判据在 providerKeyAccess 那一层。
  const registry = quotaRegistryFrom({
    isPending: plugins.isPending,
    isError: plugins.isError,
    error: plugins.error,
    plugins: plugins.data?.plugins,
  })
  // 账号类型那一份：种类 → 标题与格子。没到手时凭据入口不放行（见 accessOf）。
  const providerKinds = providerKindsFrom({
    isPending: providerKindsQuery.isPending,
    isError: providerKindsQuery.isError,
    error: providerKindsQuery.error,
    kinds: providerKindsQuery.data?.kinds,
  })
  // 那一类平台的凭据入口：能不能填凭据、填哪几格（位置就是顺序，
  // SetProviderKeys 按位置读）。
  const accessOf = (upstream: Upstream) =>
    providerKeyAccess({
      kind: upstream.kind,
      isOpenPlatform: upstream.isOpenPlatform,
      platformLabel: upstream.label || upstream.id,
      quotaPlugin: upstream.quotaPlugin,
      kinds: providerKinds,
      registry,
    })
  const keysTarget = keysFor ? findAccount(list, keysFor) : undefined
  const keysAccess = keysTarget ? accessOf(keysTarget.upstream) : undefined
  // 弹窗只在格子数说得准的时候开：说不准就发上去一个短一截的 keys 数组，
  // 服务端按位置写，短掉的那几段就被清成空串了。
  const keysLayout =
    keysAccess?.status === 'ready' ? keysAccess.layout : null

  return (
    <PageShell
      title='平台'
      description='平台分两种：内置的模板平台，和自己在面板上加的开放平台。每个平台下可以有多个账号。'
      actions={
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            aria-pressed={sorting}
            onClick={() => setSorting((value) => !value)}
          >
            {sorting ? '完成排序' : '排序'}
          </Button>
          <Button onClick={openAddPlatform}>
            <Plus />
            新增平台
          </Button>
        </div>
      }
    >

      <Card>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title='网关没有返回任何平台'
              description='正常情况下会有九个内置平台'
            />
          ) : sorting ? (
            <PlatformSortList
              platforms={list}
              onMove={(from, to) => {
                const ids = list.map((upstream) => upstream.id)
                const next = movePlatformOrder(ids, from, to)
                if (next !== ids) writePlatformOrder(next)
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>平台</TableHead>
                  <TableHead>区域</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>生效策略</TableHead>
                  <TableHead className='text-right'>账号</TableHead>
                  {/* 操作列：列宽就是几个按钮的宽（w-max），窄屏时（xl 以下）
                      收窄一点让按钮换行摆，不把它们推出可视区。 */}
                  <TableHead className='sticky right-0 z-20 w-max max-xl:w-40 xl:min-w-max border-l bg-background text-right whitespace-nowrap'>
                    操作
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((upstream) => {
                  const isExpanded = expanded === upstream.id
                  // 刷新模型目录摆不摆：只看这个平台是不是开放平台（开放平台的
                  // 目录一律从上游拉，模拟客户端的目录归代码）。
                  const refreshControl = refreshModelsControl(
                    upstream.isOpenPlatform
                  )
                  return (
                    <Fragment key={upstream.id}>
                      <TableRow
                        data-state={isExpanded ? 'selected' : undefined}
                        className='group cursor-pointer'
                        onClick={() =>
                          setExpanded(isExpanded ? null : upstream.id)
                        }
                      >
                        {/* 平台这一列是能伸缩的那一列：文字（名字、id、地址、
                            额度）允许换行，窄屏时先压缩它。 */}
                        <TableCell className='whitespace-normal'>
                          {/* 平台这一列能伸缩，但有下限：窄到一列只放得下
                              一个字就难看了。 */}
                          <div className='flex min-w-40 max-lg:min-w-32 items-start gap-1.5'>
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
                              <span className='font-medium'>
                                {upstream.label || upstream.id}
                              </span>
                              {/* 平台的 id：客户端路径里那一段，也是客户端里那个
                                  provider 的名字。 */}
                              <span className='font-mono text-xs break-all text-muted-foreground'>
                                {upstream.id}
                              </span>
                              {/* 开放平台的配置：地址、模型目录、额度插件与额度。
                                  模拟客户端那一族（表里有行、地址与目录归代码）
                                  没有地址与插件这两格。 */}
                              {upstream.isOpenPlatform ? (
                                <OpenPlatformFacts
                                  upstream={upstream}
                                  kinds={kinds}
                                  registry={registry}
                                  refresh={refreshOutcomes[upstream.id]}
                                />
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className='text-xs text-muted-foreground'>
                          {upstream.region
                            ? (REGION_LABELS[upstream.region] ?? upstream.region)
                            : '—'}
                        </TableCell>
                        {/* 状态这一列也是能伸缩的：结论那句允许换行，但也有
                            下限（窄到一列只放得下一个字就难看了）。 */}
                        <TableCell className='whitespace-normal'>
                          {/* 能不能接由后端说：有开着的账号就是开着的。 */}
                          <div className='grid min-w-24 max-lg:min-w-20 gap-0.5'>
                            <UpstreamStateBadge state={upstream.state} />
                            {/* 后端拼好的一句话：为什么现在不能接。 */}
                            {upstream.stateReason ? (
                              <span className='text-xs text-muted-foreground'>
                                {upstream.stateReason}
                              </span>
                            ) : null}
                            {/* 冷却到什么时候：stateReason 里已经说了的时候不重复。 */}
                            {!upstream.stateReason && upstream.cooldownUntilMs > 0n ? (
                              <span className='text-xs text-muted-foreground'>
                                {`冷却到 ${formatLocalMoment(upstream.cooldownUntilMs)}`}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          {/* 策略在这一格自己处理点击：改策略不该顺带把这一行
                              展开。 */}
                          <div onClick={(event) => event.stopPropagation()}>
                            <ProviderPolicySelect
                              upstream={upstream}
                              listUpdatedAt={upstreams.dataUpdatedAt}
                            />
                          </div>
                        </TableCell>
                        <TableCell className='text-right font-mono'>
                          {upstream.accountCount}
                        </TableCell>
                        {/* 操作列：宽屏时一行摆开（列宽就是按钮的宽），窄屏时
                            收窄一点让按钮换行摆 —— 按钮不压缩，也不被推出
                            可视区。底色不透明：横向滚动时，从它背后过去的
                            列不会透出来。 */}
                        <TableCell className='sticky right-0 z-10 w-max max-xl:w-40 xl:min-w-max border-l bg-background text-right whitespace-nowrap group-hover:bg-muted/50 group-data-[state=selected]:bg-muted'>
                          <div
                            className='flex min-w-max max-xl:min-w-0 flex-wrap items-center justify-end gap-2'
                            onClick={(event) => event.stopPropagation()}
                          >
                            {/* 自定义模型：写的是平台那一行上的人工元数据，所以跟
                                「有行才能改」同一个判据。模板平台的目录在代码里，
                                人写的那一份一样能覆盖它。 */}
                            {upstream.fromRow ? (
                              <PlatformModelsButton platform={upstream} />
                            ) : null}
                            {/* 能改能删看的是表里有没有它这一行：开放平台与模拟客户
                                端都有行，只有代码没有行的才只能开关（在账号上）。 */}
                            {upstream.fromRow ? (
                              <Button
                                size='sm'
                                variant='outline'
                                onClick={() => openEditPlatform(upstream)}
                              >
                                编辑
                              </Button>
                            ) : null}
                            {/* 刷新模型目录只给开放平台：开放平台的目录一律从
                                上游拉，模拟客户端的目录归代码。 */}
                            {refreshControl ? (
                              <Button
                                size='sm'
                                variant='outline'
                                onClick={() =>
                                  refreshModels.mutate(
                                    { platformId: upstream.id },
                                    {
                                      // 成功那句由面板自己说：拉回来几个模型。
                                      onSuccess: (result) => {
                                        setRefreshOutcomes((prev) => ({
                                          ...prev,
                                          [upstream.id]: {
                                            ok: true,
                                            message: `已刷新，${result.models.length} 个模型`,
                                            models: [...result.models],
                                          },
                                        }))
                                      },
                                      // 失败（拉不到、服务端说 ok=false）都走
                                      // `describeError`：原因写在平台那一行下面，
                                      // 不再弹 toast 说一遍。
                                      onError: (error) => {
                                        setRefreshOutcomes((prev) => ({
                                          ...prev,
                                          [upstream.id]: {
                                            ok: false,
                                            message: describeError(error),
                                            models: [],
                                          },
                                        }))
                                      },
                                    }
                                  )
                                }
                              >
                                刷新模型目录
                              </Button>
                            ) : null}
                            {/* 删平台之前要先扫主路由模型：指向它的那些
                                模型会跟着一起删，这事得在弹框里说清楚。 */}
                            {upstream.fromRow ? (
                              <DeletePlatformButton platform={upstream} />
                            ) : null}
                            <Button
                              size='sm'
                              onClick={() => setAdding(upstream)}
                            >
                              <Plus />
                              新增账号
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded ? (
                        <TableRow>
                          <TableCell colSpan={7} className='bg-muted/30 p-0'>
                            <div className='grid gap-4 p-4'>
                              {/* 签到是账号的事，但跟账号表不是一回事：
                                  单独一块，不占账号表的一列。 */}
                              <BenefitsPanel
                                accounts={upstream.accounts}
                                benefits={benefits.data?.benefits ?? []}
                                loading={benefits.isPending}
                                error={benefits.error}
                                running={runBenefit.isPending}
                                runResult={runResult}
                                onRun={() =>
                                  runBenefit.mutate(undefined, {
                                    onSuccess: (result) =>
                                      setRunResult(result),
                                  })
                                }
                                onRetry={() => void benefits.refetch()}
                              />
                              <ProviderAccounts
                                access={accessOf(upstream)}
                                accounts={upstream.accounts}
                                loggingIn={login.pending}
                                busyAccountId={busyAccountId}
                                refreshing={refreshing}
                                onLogin={(account) =>
                                  login.start({
                                    // 路径里走的是平台：登录也按平台 + 账号行办。
                                    upstreamId: upstream.id,
                                    id: account.id,
                                    label: account.alias || account.id,
                                  })
                                }
                                onDelete={(account) => setDeleteTarget(account)}
                                onToggleEnabled={(account, enabled) =>
                                  setEnabled.mutate({
                                    accountId: account.id,
                                    enabled,
                                  })
                                }
                                onRename={(account, alias) =>
                                  updateProvider.mutate({
                                    id: account.id,
                                    alias,
                                  })
                                }
                                onWeightChange={(account, weight) =>
                                  updateProvider.mutate({
                                    id: account.id,
                                    // 契约里的别名没有 presence 位：不带它就是清掉。
                                    // 只改权重时把现在的别名一起带上。
                                    alias: account.alias ?? '',
                                    weight,
                                  })
                                }
                                onManageKeys={(account) => {
                                  // 账号不在列表里了：不要把 key 写到别处去。
                                  if (!findAccount(list, account.id)) {
                                    toast.error('找不到这个账号', {
                                      description: `${account.id} 不在平台列表里`,
                                    })
                                    return
                                  }
                                  setKeysFor(account.id)
                                }}
                              />
                            </div>
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

      <AddAccountDialog
        open={adding !== null}
        platform={adding?.id ?? ''}
        platformLabel={adding ? (adding.label || adding.id) : ''}
        pending={addAccount.isPending}
        onOpenChange={(open) => {
          if (!open) setAdding(null)
        }}
        onSubmit={(input) => {
          addAccount.mutate(input, { onSuccess: () => setAdding(null) })
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

      {/* 凭据弹窗：这一类不用填 key（或者账号找不到了）时没有弹窗。 */}
      <ProviderKeysDialog
        open={keysTarget !== undefined && keysLayout !== null}
        layout={keysLayout}
        onOpenChange={(open) => {
          if (!open) setKeysFor(null)
        }}
        pending={setKeys.isPending}
        onSubmit={(keys) => {
          if (!keysTarget) return
          setKeys.mutate(
            { accountId: keysTarget.account.id, keys },
            {
              onSuccess: () => setKeysFor(null),
            }
          )
        }}
      />

      {/* 新增与修改开放平台：同一个弹窗。改的时候是整单提交。 */}
      <PlatformDialog
        open={addingPlatform || editingPlatform !== null}
        platform={editingPlatform ?? undefined}
        existing={list}
        kinds={kinds}
        registry={registry}
        pending={addPlatform.isPending || updatePlatform.isPending}
        error={addPlatform.error ?? updatePlatform.error}
        onOpenChange={(open) => {
          if (open) return
          setAddingPlatform(false)
          setEditingPlatform(null)
        }}
        onSubmit={(input) => {
          // 新增那一单带 kind，改那一单不带 —— 看形状就分得清，不靠外面那个
          // 状态碰巧对上。
          if ('kind' in input) {
            addPlatform.mutate(input, {
              onSuccess: () => setAddingPlatform(false),
            })
            return
          }
          updatePlatform.mutate(input, {
            onSuccess: () => setEditingPlatform(null),
          })
        }}
      />

      {/* 注销要确认：这一行删掉就没了，凭据也跟着删。 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              注销 {deleteTarget ? deleteTarget.alias || deleteTarget.id : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              删除该账号会同时删除其名下的 {deleteTarget?.credentialCount ?? 0}{' '}
              条凭据，且不可恢复。平台本身保留，客户端的地址不变
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
                deleteAccount.mutate({ id: target.id })
              }}
            >
              注销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}

/**
 * 排序模式下的平台列表：一行一个平台，拖着走，或者用行尾那两个按钮挪。
 *
 * 只在这一模式下出现：退出后行回到表格里，点行展开、按钮可点。
 * 次序只存进浏览器，不传后端。
 */
function PlatformSortList({
  platforms,
  onMove,
}: {
  platforms: Upstream[]
  onMove: (from: number, to: number) => void
}) {
  /** 正在拖的那一行（平台 id）。 */
  const [dragging, setDragging] = useState<string | null>(null)

  return (
    <div className='grid gap-2 p-3'>
      <p className='text-xs text-muted-foreground'>拖动行调整顺序</p>
      <ul aria-label='平台排序' className='grid gap-1'>
        {platforms.map((upstream, index) => {
          const last = index === platforms.length - 1
          return (
            <li
              key={upstream.id}
              data-platform-id={upstream.id}
              draggable
              tabIndex={0}
              onDragStart={(event) => {
                setDragging(upstream.id)
                event.dataTransfer?.setData('text/plain', upstream.id)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              }}
              // 只有落在别的一行上才算一次换位：不 preventDefault 就收不到 drop。
              onDragOver={(event) => {
                if (dragging !== null && dragging !== upstream.id) {
                  event.preventDefault()
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = platforms.findIndex((row) => row.id === dragging)
                setDragging(null)
                if (from < 0 || from === index) return
                onMove(from, index)
              }}
              onDragEnd={() => setDragging(null)}
              // 键盘上另有一条：焦点在行上时 Alt + 上/下箭头。
              onKeyDown={(event) => {
                if (!event.altKey) return
                if (event.key === 'ArrowUp' && index > 0) {
                  event.preventDefault()
                  onMove(index, index - 1)
                }
                if (event.key === 'ArrowDown' && !last) {
                  event.preventDefault()
                  onMove(index, index + 1)
                }
              }}
              className={`flex cursor-grab items-center gap-2 rounded-md border px-3 py-2 ${
                dragging === upstream.id ? 'opacity-50' : ''
              }`}
            >
              <GripVertical
                aria-hidden
                className='size-4 shrink-0 text-muted-foreground'
              />
              <div className='grid min-w-0 flex-1 gap-0.5'>
                <span className='text-sm font-medium'>
                  {upstream.label || upstream.id}
                </span>
                <span className='font-mono text-xs break-all text-muted-foreground'>
                  {upstream.id}
                </span>
              </div>
              <Button
                size='sm'
                variant='outline'
                aria-label={`上移 ${upstream.id}`}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                上移
              </Button>
              <Button
                size='sm'
                variant='outline'
                aria-label={`下移 ${upstream.id}`}
                disabled={last}
                onClick={() => onMove(index, index + 1)}
              >
                下移
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 在所有平台的账号里找一个账号。
 *
 * 找到时把它所在的平台一起带出来：key 的种类与格子看平台，不看账号。
 */
function findAccount(
  list: Upstream[],
  accountId: string
): { account: Account; upstream: Upstream } | undefined {
  for (const upstream of list) {
    const account = upstream.accounts.find((row) => row.id === accountId)
    if (account) return { account, upstream }
  }
  return undefined
}
