import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BeginLoginResponseSchema,
  CredentialSchema,
  GetLoginStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  LoginSessionSchema,
  LogoutAccountResponseSchema,
  SetUpstreamEnabledResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
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

/**
 * 一个 Provider 名下两个账号（多租户的那种）。
 *
 * 租户 1 登录着，租户 2 没有凭据。
 */
function accounts(loggedOut = false) {
  return create(ListAccountsResponseSchema, {
    accounts: [
      create(AccountSchema, {
        id: 'tokenrhythm:1',
        upstreamId: 'tokenrhythm',
        label: 'TokenRhythm 租户 1',
        status: loggedOut ? 'missing' : 'usable',
        credentialCount: loggedOut ? 0 : 2,
      }),
      create(AccountSchema, {
        id: 'tokenrhythm:2',
        upstreamId: 'tokenrhythm',
        label: 'TokenRhythm 租户 2',
        status: 'missing',
        credentialCount: 0,
      }),
    ],
  })
}

function clientWith(
  extra: Partial<Parameters<typeof mockAdminClient>[0]> = {},
  loggedOut = () => false
) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          create(UpstreamSchema, {
            id: 'tokenrhythm',
            label: 'TokenRhythm',
            enabled: true,
          }),
        ],
      }),
    ListProviderKinds: () => create(ListProviderKindsResponseSchema, { kinds: [] }),
    SetUpstreamEnabled: () =>
      create(SetUpstreamEnabledResponseSchema, {
        ok: true,
        pendingRestart: false,
        message: '已保存，已经生效',
      }),
    ListAccounts: () => accounts(loggedOut()),
    ListCredentials: (input) =>
      create(ListCredentialsResponseSchema, {
        credentials: [
          create(CredentialSchema, {
            id: `session:provider:${input.accountId ?? ''}`,
            accountId: input.accountId ?? '',
            kind: 'session',
            label: '登录会话',
            masked: 'ab****',
            fingerprint: 'a1b2',
            status: 'usable',
          }),
        ],
      }),
    ...extra,
  })
}

/** 展开 Provider 那一行。 */
async function expand(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', {
    name: '展开 tokenrhythm 的账号与凭据',
  })
  await user.click(button)
}

describe('Provider 页的账号与凭据', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    // 上一次登录可能把 login_id 留在 hash 里，别带进下一个用例。
    window.history.replaceState(null, '', '/')
  })

  it('点一行，展开那个 Provider 的账号与凭据', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(), children: <UpstreamsPage /> })

    // 没展开的时候看不到账号。
    expect(
      screen.queryByText('TokenRhythm 租户 1')
    ).not.toBeInTheDocument()

    await expand(user)

    expect(await screen.findByText('TokenRhythm 租户 1')).toBeInTheDocument()
    expect(screen.getByText('TokenRhythm 租户 2')).toBeInTheDocument()
    // 默认选中第一个账号，它的凭据列在下面。
    expect(
      await screen.findByText('session:provider:tokenrhythm:1')
    ).toBeInTheDocument()
  })

  it('没有凭据的账号给「登录」，登录着的给「注销」', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(), children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('TokenRhythm 租户 1')

    const loggedIn = screen.getByText('TokenRhythm 租户 1').closest('tr')
    const without = screen.getByText('TokenRhythm 租户 2').closest('tr')
    expect(loggedIn).not.toBeNull()
    expect(without).not.toBeNull()

    // 登录着的那个：有注销，没有登录。
    expect(
      within(loggedIn as HTMLElement).getByRole('button', { name: '注销' })
    ).toBeInTheDocument()
    expect(
      within(loggedIn as HTMLElement).queryByRole('button', { name: '登录' })
    ).not.toBeInTheDocument()

    // 没有凭据的那个：有登录，没有注销。
    expect(
      within(without as HTMLElement).getByRole('button', { name: '登录' })
    ).toBeInTheDocument()
    expect(
      within(without as HTMLElement).queryByRole('button', { name: '注销' })
    ).not.toBeInTheDocument()
  })

  it('注销要确认，确认之后调 LogoutAccount', async () => {
    const user = userEvent.setup({ delay: null })
    const loggedOut: string[] = []
    const client = clientWith({
      LogoutAccount: (input) => {
        loggedOut.push(input.accountId ?? '')
        return create(LogoutAccountResponseSchema, {
          ok: true,
          message: '注销了，删掉 2 条凭据',
          removed: 2,
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('TokenRhythm 租户 1')

    const row = screen.getByText('TokenRhythm 租户 1').closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '注销' })
    )

    // 先问一遍：凭据删掉就回不来了。
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/凭据会全部删掉/)).toBeInTheDocument()
    expect(loggedOut).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: '注销' }))

    await waitFor(() => {
      expect(loggedOut).toEqual(['tokenrhythm:1'])
    })
  })

  it('注销完账号回到「没有凭据」，「登录」按钮又出来了', async () => {
    const user = userEvent.setup({ delay: null })
    let gone = false
    const client = clientWith(
      {
        LogoutAccount: () => {
          gone = true
          return create(LogoutAccountResponseSchema, {
            ok: true,
            message: '注销了，删掉 2 条凭据',
            removed: 2,
          })
        },
      },
      () => gone
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('TokenRhythm 租户 1')

    const row = screen.getByText('TokenRhythm 租户 1').closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '注销' })
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '注销' }))

    // 账号回到「没有凭据」：徽章换文案，按钮换回「登录」。
    await waitFor(() => {
      const next = screen.getByText('TokenRhythm 租户 1').closest('tr')
      expect(
        within(next as HTMLElement).getByRole('button', { name: '登录' })
      ).toBeInTheDocument()
    })
    expect(screen.getAllByText('没有凭据').length).toBeGreaterThan(0)
  })

  it('点开关不会把那一行顺带展开', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(), children: <UpstreamsPage /> })

    const toggle = await screen.findByRole('switch', {
      name: 'TokenRhythm 的开关',
    })
    await user.click(toggle)

    // 开关自己处理点击：这一行不该跟着展开。
    expect(screen.queryByText('TokenRhythm 租户 1')).not.toBeInTheDocument()
  })

  it('点「登录」发起一次登录，login_id 记在 hash 里', async () => {
    const user = userEvent.setup({ delay: null })
    const began: { upstreamId: string; accountId: string }[] = []
    const client = clientWith({
      BeginLogin: (input) => {
        began.push({
          upstreamId: input.upstreamId ?? '',
          accountId: input.accountId ?? '',
        })
        return create(BeginLoginResponseSchema, {
          ok: true,
          message: '去浏览器里同意一下。',
          session: create(LoginSessionSchema, {
            loginId: 'login-1',
            upstreamId: input.upstreamId ?? '',
            accountId: input.accountId ?? '',
            status: 'pending',
            method: 'password',
            authorizationUrl: '',
            userCode: '',
            expiresAt: BigInt(Date.now() + 60_000),
            message: '在面板上填账号与密码。',
            username: '',
          }),
        })
      },
      GetLoginStatus: () =>
        create(GetLoginStatusResponseSchema, {
          ok: true,
          session: create(LoginSessionSchema, {
            loginId: 'login-1',
            upstreamId: 'tokenrhythm',
            accountId: 'tokenrhythm:2',
            status: 'pending',
            method: 'password',
            authorizationUrl: '',
            userCode: '',
            expiresAt: BigInt(Date.now() + 60_000),
            message: '在面板上填账号与密码。',
            username: '',
          }),
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user)
    await screen.findByText('TokenRhythm 租户 2')

    const row = screen.getByText('TokenRhythm 租户 2').closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '登录' })
    )

    await waitFor(() => {
      expect(began).toEqual([
        { upstreamId: 'tokenrhythm', accountId: 'tokenrhythm:2' },
      ])
    })
    // 没走完的登录记在 hash 里：刷新页面还能接上。
    await waitFor(() => {
      expect(window.location.hash).toContain('login=login-1')
    })
  })
})
