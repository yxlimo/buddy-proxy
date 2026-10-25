import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  AddAccountResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
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

/** 一个平台，带着它的账号。 */
function platform(
  overrides: Partial<MessageInitShape<typeof UpstreamSchema>> = {}
) {
  const base: MessageInitShape<typeof UpstreamSchema> = {
    id: 'minimax',
    kind: 'minimax',
    label: 'MiniMax Code',
    region: 'cn',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 1,
    hasEnabledAccount: true,
    accounts: [
      create(AccountSchema, {
        id: 'minimax',
        platform: 'minimax',
        alias: '主账号',
        enabled: true,
        status: 'usable',
        credentialCount: 1,
      }),
    ],
  }
  return create(UpstreamSchema, Object.assign(base, overrides))
}

/** 一个只有平台列表的假客户端：账号相关的请求按空答复。 */
function clientWith(
  upstreams: Upstream[],
  extra: Partial<Parameters<typeof mockAdminClient>[0]> = {}
) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, { upstreams }),
    ListProviderKinds: () =>
      create(ListProviderKindsResponseSchema, { kinds: [] }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    ...extra,
  })
}

describe('上游页的平台列表', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('一行一个平台：名字、区域、账号数都从后端来', async () => {
    const client = clientWith([
      platform(),
      platform({
        id: 'qoder-cn',
        kind: 'qoder',
        label: 'Qoder（中国区）',
        region: 'cn',
        accountCount: 2,
        accounts: [],
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('MiniMax Code')).toBeInTheDocument()
    expect(screen.getByText('Qoder（中国区）')).toBeInTheDocument()
    // 平台的 id 是客户端路径里那一段，面板照原样显示。
    expect(screen.getByText('qoder-cn')).toBeInTheDocument()
    // 区域是给人看的话。
    expect(screen.getAllByText('中国区')).toHaveLength(2)
    // 账号数由后端给。
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('平台行没有开关，也没有删除：平台是模板，关不掉也删不掉', async () => {
    const client = clientWith([platform()])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('MiniMax Code')

    // 没展开的时候一个开关都没有（开关在账号上）。
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    // 也没有删平台的按钮。
    expect(
      screen.queryByRole('button', { name: /删掉 minimax/ })
    ).not.toBeInTheDocument()
  })

  it('状态按后端给的 state 显示', async () => {
    const client = clientWith([
      platform({ id: 'ready', label: '就绪的', state: UpstreamState.READY }),
      platform({
        id: 'empty',
        label: '没账号的',
        state: UpstreamState.NO_CREDENTIAL,
        accountCount: 0,
        hasEnabledAccount: false,
        accounts: [],
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('就绪')).toBeInTheDocument()
    expect(screen.getByText('没登录')).toBeInTheDocument()
  })

  it('界面上不提「重启后生效」：开关是热的', async () => {
    const client = clientWith([platform()])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('MiniMax Code')
    expect(screen.queryByText(/重启后生效/)).not.toBeInTheDocument()
    expect(screen.queryByText(/重启网关/)).not.toBeInTheDocument()
  })

  it('展开一个平台，看到它名下的账号', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([platform()])

    renderWithClient({ client, children: <UpstreamsPage /> })

    // 没展开的时候看不到账号。
    expect(screen.queryByText('主账号')).not.toBeInTheDocument()

    await user.click(
      await screen.findByRole('button', {
        name: '展开 minimax 的账号与凭据',
      })
    )

    expect(await screen.findByText('主账号')).toBeInTheDocument()
    // 账号就是 provider 表里那一行：面板把 id 也显示出来（平台 id 也叫
    // minimax，所以这里数一下出现几次）。
    expect(screen.getAllByText('minimax')).toHaveLength(2)
  })

  it('平台下没有账号：展开时说明去哪儿加', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([
      platform({ accountCount: 0, accounts: [], hasEnabledAccount: false }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 minimax 的账号与凭据',
      })
    )

    expect(await screen.findByText('这个平台还没有账号')).toBeInTheDocument()
    expect(screen.getByText(/点这一行的「新增账号」加一个/)).toBeInTheDocument()
  })

  it('「新增账号」带平台与别名，加完关掉弹窗', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { platform: string; alias: string }[] = []
    const client = clientWith([platform()], {
      AddAccount: (input) => {
        sent.push({
          platform: input.platform ?? '',
          alias: input.alias ?? '',
        })
        return create(AddAccountResponseSchema, {
          ok: true,
          message: '加上了',
          id: 'minimax-2',
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增账号' }))

    const dialog = await screen.findByRole('dialog')
    // 弹窗说清楚是在哪个平台下加，客户端地址不变。
    expect(within(dialog).getByText(/MiniMax Code/)).toBeInTheDocument()
    expect(within(dialog).getByText(/\/minimax\/v1/)).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('别名（可以不填）'), 'M plan')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([{ platform: 'minimax', alias: 'M plan' }])
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(toastSuccess).toHaveBeenCalledWith('加上了')
  })

  it('别名可以不填：加的时候带空串，名字由服务端起', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([platform()], {
      AddAccount: (input) => {
        sent.push(input.alias ?? '')
        return create(AddAccountResponseSchema, { ok: true, id: 'minimax-2' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增账号' }))
    await user.click(await screen.findByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([''])
    })
  })

  it('平台列表取不到：给错误与重试，不假装是空的', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => {
        throw new Error('网关炸了')
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText(/网关炸了/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })
})
