import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BeginLoginResponseSchema,
  CreditSummarySchema,
  CredentialSchema,
  DeleteAccountResponseSchema,
  GetLoginStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  LoginSessionSchema,
  LogoutAccountResponseSchema,
  ProviderPolicy,
  SetAccountEnabledResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UpstreamState,
  UpdateProviderResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Account, Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

/** 一个账号。 */
function account(
  overrides: Partial<MessageInitShape<typeof AccountSchema>> = {}
): Account {
  const base: MessageInitShape<typeof AccountSchema> = {
    id: 'minimax',
    platform: 'minimax',
    alias: '主账号',
    enabled: true,
    status: 'usable',
    credentialCount: 1,
    quota: create(UpstreamQuotaSchema, {
      credits: create(CreditSummarySchema, {
        total: 2000,
        used: 800,
        remaining: 1200,
      }),
    }),
  }
  return create(AccountSchema, Object.assign(base, overrides))
}

/** 一个平台，带着它名下的账号。 */
function platform(accounts: Account[]): Upstream {
  return create(UpstreamSchema, {
    id: 'minimax',
    kind: 'minimax',
    label: 'MiniMax Code',
    region: 'cn',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: accounts.length,
    hasEnabledAccount: accounts.some((row) => row.enabled),
    accounts,
  })
}

/** 假客户端。`session.credential` 改那条会话凭据的样子。 */
function clientWith(
  accounts: Account[],
  extra: Partial<Parameters<typeof mockAdminClient>[0]> = {},
  session: {
    credential?: Partial<{
      id: string
      kind: string
      status: string
      lastError: string
    }>
  } = {}
) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, { upstreams: [platform(accounts)] }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts }),
    ListProviderKinds: () => create(ListProviderKindsResponseSchema, { kinds: [] }),
    ListCredentials: (input) =>
      create(ListCredentialsResponseSchema, {
        credentials: [
          create(CredentialSchema, {
            id: `session:${input.accountId ?? ''}`,
            accountId: input.accountId ?? '',
            kind: 'session',
            label: '登录会话',
            masked: 'ab****',
            fingerprint: 'a1b2',
            status: 'usable',
            ...session.credential,
          }),
        ],
      }),
    ...extra,
  })
}

/** 展开一个平台。 */
async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', {
      name: '展开 minimax 的账号与凭据',
    })
  )
}

describe('平台下的账号', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('账号行显示别名、状态、凭据数与额度', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([account()])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)

    const cell = await screen.findByText('主账号')
    const row = cell.closest('tr') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByText('已登录')).toBeInTheDocument()
    // 凭据数由后端给。
    expect(within(row).getByText('1')).toBeInTheDocument()
    // 额度分三种，点数不写成钱。
    expect(screen.getByText('积分')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
  })

  it('后端说了账号为什么不可用，就照它的话显示', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([
      account({
        status: 'error',
        detail: '凭据被上游拒了，要重新登录',
        credentialCount: 1,
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)

    expect(
      await screen.findByText('凭据被上游拒了，要重新登录')
    ).toBeInTheDocument()
  })

  it('账号在冷却中：说清楚冷却到什么时候、因为什么', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([
      account({
        cooldownUntilMs: 1793160000000n,
        cooldownReason: 'rate-limit',
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)

    const cell = await screen.findByText('主账号')
    const row = cell.closest('tr') as HTMLElement
    expect(within(row).getByText(/冷却到 .*（rate-limit）/)).toBeInTheDocument()
  })

  it('点「登录」按平台与账号行发起一次登录，login_id 记在 hash 里', async () => {
    const user = userEvent.setup({ delay: null })
    const began: { upstreamId: string; accountId: string }[] = []
    const client = clientWith(
      [account()],
      {
        BeginLogin: (input) => {
          began.push({
            upstreamId: input.upstreamId ?? '',
            accountId: input.accountId ?? '',
          })
          return create(BeginLoginResponseSchema, {
            ok: true,
            message: '在面板上填账号与密码。',
            session: create(LoginSessionSchema, {
              loginId: 'login-1',
              upstreamId: input.upstreamId ?? '',
              accountId: input.accountId ?? '',
              status: 'pending',
              method: 'password',
              expiresAt: BigInt(Date.now() + 60_000),
              message: '在面板上填账号与密码。',
            }),
          })
        },
        GetLoginStatus: () =>
          create(GetLoginStatusResponseSchema, {
            ok: true,
            session: create(LoginSessionSchema, {
              loginId: 'login-1',
              upstreamId: 'minimax',
              accountId: 'minimax',
              status: 'pending',
              method: 'password',
              expiresAt: BigInt(Date.now() + 60_000),
              message: '在面板上填账号与密码。',
            }),
          }),
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    const row = (await screen.findByText('主账号')).closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '登录' })
    )

    await waitFor(() => {
      expect(began).toEqual([{ upstreamId: 'minimax', accountId: 'minimax' }])
    })
    await waitFor(() => {
      expect(window.location.hash).toContain('login=login-1')
    })
  })

  it('「注销」要先确认，确认框写明凭据一起删，确认后发 DeleteAccount', async () => {
    const user = userEvent.setup({ delay: null })
    const deleted: string[] = []
    const loggedOut: string[] = []
    const client = clientWith([account({ credentialCount: 2 })], {
      DeleteAccount: (input) => {
        deleted.push(input.id ?? '')
        return create(DeleteAccountResponseSchema, {
          ok: true,
          message: '删掉了，连带 2 条凭据',
        })
      },
      LogoutAccount: (input) => {
        loggedOut.push(input.accountId ?? '')
        return create(LogoutAccountResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    const row = (await screen.findByText('主账号')).closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '注销 主账号' })
    )

    const dialog = await screen.findByRole('alertdialog')
    // 说清楚凭据一起删、删完回不来。
    expect(within(dialog).getByText(/2 条凭据也一起删掉/)).toBeInTheDocument()
    expect(within(dialog).getByText(/删完回不来/)).toBeInTheDocument()
    // 还没确认：什么都没发。
    expect(deleted).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: '注销' }))

    await waitFor(() => {
      expect(deleted).toEqual(['minimax'])
    })
    // 注销 = 删账号行，不是「只清凭据」。
    expect(loggedOut).toEqual([])
  })

  it('取消确认框：什么都不发', async () => {
    const user = userEvent.setup({ delay: null })
    const deleted: string[] = []
    const client = clientWith([account()], {
      DeleteAccount: (input) => {
        deleted.push(input.id ?? '')
        return create(DeleteAccountResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    const row = (await screen.findByText('主账号')).closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '注销 主账号' })
    )

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(deleted).toEqual([])
  })

  it('账号的开关走 SetAccountEnabled，状态以服务端的答复为准', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { accountId: string; enabled: boolean }[] = []
    let enabled = true
    const client = clientWith([], {
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [platform([account({ enabled })])],
        }),
      SetAccountEnabled: (input) => {
        enabled = input.enabled ?? false
        sent.push({
          accountId: input.accountId ?? '',
          enabled: input.enabled ?? false,
        })
        return create(SetAccountEnabledResponseSchema, {
          ok: true,
          pendingRestart: false,
          message: '已保存，已经生效',
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)

    const toggle = await screen.findByRole('switch', { name: '主账号 的开关' })
    expect(toggle).toBeChecked()

    await user.click(toggle)

    await waitFor(() => {
      expect(sent).toEqual([{ accountId: 'minimax', enabled: false }])
    })
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: '主账号 的开关' })
      ).not.toBeChecked()
    })
  })

  it('两个账号各有各的开关：拨一个，发的是那一行的账号 id', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith(
      [
        account(),
        account({
          id: 'minimax-2',
          alias: 'M plan',
          enabled: false,
          status: 'missing',
          credentialCount: 0,
        }),
      ],
      {
        SetAccountEnabled: (input) => {
          sent.push(input.accountId ?? '')
          return create(SetAccountEnabledResponseSchema, {
            ok: true,
            message: '已保存，已经生效',
          })
        },
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('M plan')

    await user.click(screen.getByRole('switch', { name: 'M plan 的开关' }))

    await waitFor(() => {
      expect(sent).toEqual(['minimax-2'])
    })
  })

  it('点开关不把这一行选中，也不换下面凭据表的口径', async () => {
    const user = userEvent.setup({ delay: null })
    const asked: string[] = []
    const client = clientWith(
      [
        account(),
        account({ id: 'minimax-2', alias: 'M plan', credentialCount: 1 }),
      ],
      {
        SetAccountEnabled: () =>
          create(SetAccountEnabledResponseSchema, { ok: true }),
        ListCredentials: (input) => {
          asked.push(input.accountId ?? '')
          return create(ListCredentialsResponseSchema, { credentials: [] })
        },
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('M plan')

    // 默认选第一个账号。
    await waitFor(() => {
      expect(asked).toEqual(['minimax'])
    })

    await user.click(screen.getByRole('switch', { name: 'M plan 的开关' }))

    // 开关自己处理点击：不该把选中的账号换到第二行去。改完开关会重取账号，
    // 凭据跟着重取一次，但问的还是原来那个账号。
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled()
    })
    expect(new Set(asked)).toEqual(new Set(['minimax']))
    expect(asked).not.toContain('minimax-2')
  })

  it('改别名发的是账号 id，不是平台 id', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; alias: string }[] = []
    const client = clientWith(
      [
        account({ id: 'minimax-2', alias: 'M plan' }),
        account({ id: 'minimax-3', alias: '备用' }),
      ],
      {
        UpdateProvider: (input) => {
          sent.push({
            id: input.id ?? '',
            alias: input.alias ?? '',
          })
          return create(UpdateProviderResponseSchema, { ok: true })
        },
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('备用')

    // 点第二个账号的铅笔：改的是那一行自己的名字。
    await user.click(screen.getByRole('button', { name: '改 minimax-3 的别名' }))
    const input = screen.getByLabelText('minimax-3 的别名')
    await user.clear(input)
    await user.type(input, '主账号备用')
    await user.click(screen.getByRole('button', { name: '保存别名' }))

    await waitFor(() => {
      expect(sent).toEqual([{ id: 'minimax-3', alias: '主账号备用' }])
    })
  })

  it('会话失效了给「重新登录」，点它走同一个账号的登录流程', async () => {
    const user = userEvent.setup({ delay: null })
    const began: { upstreamId: string; accountId: string }[] = []
    const client = clientWith(
      [account({ status: 'expired' })],
      {
        BeginLogin: (input) => {
          began.push({
            upstreamId: input.upstreamId ?? '',
            accountId: input.accountId ?? '',
          })
          return create(BeginLoginResponseSchema, {
            ok: true,
            session: create(LoginSessionSchema, {
              loginId: 'login-1',
              upstreamId: input.upstreamId ?? '',
              accountId: input.accountId ?? '',
              status: 'pending',
              method: 'password',
              expiresAt: BigInt(Date.now() + 60_000),
            }),
          })
        },
        GetLoginStatus: () =>
          create(GetLoginStatusResponseSchema, {
            ok: true,
            session: create(LoginSessionSchema, {
              loginId: 'login-1',
              upstreamId: 'minimax',
              accountId: 'minimax',
              status: 'pending',
              method: 'password',
              expiresAt: BigInt(Date.now() + 60_000),
            }),
          }),
      },
      { credential: { status: 'expired' } }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await user.click(
      await screen.findByRole('button', { name: '重新登录' })
    )

    await waitFor(() => {
      expect(began).toEqual([{ upstreamId: 'minimax', accountId: 'minimax' }])
    })
  })

  it('会话好好的：不给「重新登录」，只给「试一下」', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([account()])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByRole('button', { name: '试一下' })

    expect(
      screen.queryByRole('button', { name: '重新登录' })
    ).not.toBeInTheDocument()
    // 凭据表里也没有手动强制刷新。
    expect(
      screen.queryByRole('button', { name: '强制刷新' })
    ).not.toBeInTheDocument()
  })

  it('不是会话的凭据失效了也不给「重新登录」', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith(
      [account()],
      {},
      { credential: { kind: 'api_key', status: 'expired' } }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByRole('button', { name: '试一下' })

    // key 失效了是换一把 key 的事，重新登录解决不了。
    expect(
      screen.queryByRole('button', { name: '重新登录' })
    ).not.toBeInTheDocument()
  })

  it('凭据被拒要如实显示，不能装作没事', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith(
      [account({ status: 'error', detail: '凭据被上游拒了' })],
      {},
      { credential: { status: 'expired', lastError: 'refresh 被拒绝' } }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)

    expect(await screen.findByText('凭据被上游拒了')).toBeInTheDocument()
    expect(screen.getByText('refresh 被拒绝')).toBeInTheDocument()
  })
})
