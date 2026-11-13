import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  QuotaPluginFieldSchema,
  QuotaPluginSchema,
  SetProviderKeysResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Account, QuotaPlugin, Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { upstreamKeys } from '@/features/upstreams/api'
import { mockAdminClient } from '@/test/mock-transport'
import { listProviderKinds } from '@/test/provider-kinds-fixture'
import { makeTestQueryClient, renderWithClient } from '@/test/render'

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

/** 一个开放平台的账号：七牛云（一段推理 key 加一段额度 Cookie）。 */
function qiniuAccount(id = 'qiniu-1', alias = '七牛一'): Account {
  return create(AccountSchema, {
    id,
    platform: 'qiniu',
    alias,
    enabled: true,
    status: 'missing',
    credentialCount: 0,
  })
}

/** 一个平台，带着它名下的账号。 */
function upstream(
  id: string,
  kind: string,
  label: string,
  accounts: Account[]
) {
  return create(UpstreamSchema, {
    id,
    kind,
    label,
    state: UpstreamState.NO_CREDENTIAL,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: accounts.length,
    accounts,
  })
}

/** 一个账号。 */
function accountOf(id: string, platform: string, alias: string): Account {
  return create(AccountSchema, {
    id,
    platform,
    alias,
    enabled: true,
    status: 'missing',
    credentialCount: 0,
  })
}

/**
 * key 挂在账号上。
 *
 * 一个账号一份凭据：点了哪一个账号的「凭据」，就写到那个账号上，不写到别处
 * 去。
 */
describe('账号的 API Key', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('key 写到点它的那个账号上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []

    const client = mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              accounts: [qiniuAccount()],
            }),
          ],
        }),
      ListAccounts: () =>
        create(ListAccountsResponseSchema, { accounts: [qiniuAccount()] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, {
          count: 1,
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    // 展开那一行，账号在里面。
    await user.click(
      await screen.findByRole('button', {
        name: '展开 qiniu 的账号与凭据',
      })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.type(
      await screen.findByLabelText('推理 Key'),
      'sk-tenant-one'
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['qiniu-1'])
    })
  })

  it('key 是写到账号 id 上的，不是平台 id', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []

    const client = mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 2,
              accounts: [
                qiniuAccount(),
                qiniuAccount('qiniu-2', '七牛二'),
              ],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema)
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 qiniu 的账号与凭据',
      })
    )

    // 两个账号各有一个「凭据」按钮：点第二个账号那一行的。
    const row = (await screen.findByText('七牛二')).closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: '凭据' })
    )
    await user.type(
      await screen.findByLabelText('推理 Key'),
      'sk-tenant-two'
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['qiniu-2'])
    })
  })

  it('账号从列表里没了：弹窗关掉，不把 key 写到别处去', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    let gone = false

    const client = mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: gone ? 0 : 1,
              accounts: gone ? [] : [qiniuAccount()],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema)
      },
    })

    const queryClient = makeTestQueryClient()
    renderWithClient({ client, queryClient, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 qiniu 的账号与凭据',
      })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))
    await screen.findByRole('dialog')

    // 账号没了：重取列表之后它不在了。
    gone = true
    await queryClient.invalidateQueries({ queryKey: upstreamKeys.all })

    // 弹窗跟着关掉，不留着让人往别处写 key。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent).toEqual([])
  })
})

/**
 * 七牛云要两段凭据：推理 Key 与额度 Cookie。
 *
 * 两段各有位置：哪一段留空就是清掉哪一段，所以空串也要传上去，不能滤掉。
 */
describe('七牛云的凭据', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 只列一个七牛云上游，把每次提交的两段记下来。 */
  function qiniuClient(sent: string[][]) {
    return mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              accounts: [qiniuAccount()],
            }),
          ],
        }),
      ListAccounts: () =>
        create(ListAccountsResponseSchema, { accounts: [qiniuAccount()] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        const keys = input.keys ?? []
        sent.push(keys)
        return create(SetProviderKeysResponseSchema, {
          count: keys.length,
        })
      },
    })
  }

  it('点「凭据」打开的是两个输入框的弹窗', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    expect(await screen.findByLabelText('额度 Cookie')).toBeInTheDocument()
  })

  it('只填额度 Cookie：推理 key 留空也要占着位置', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.type(await screen.findByLabelText('额度 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['', 'c=1']])
    })
  })

  it('两段都填：推理 key 在前，额度 Cookie 在后', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.type(await screen.findByLabelText('推理 Key'), 'k1')
    await user.type(await screen.findByLabelText('额度 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['k1', 'c=1']])
    })
  })

  it('两段都空：两段都传空串上去，清不清理由后端决定', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['', '']])
    })
  })
})

/**
 * 给不给「填 key」的入口，由面板知道这一类要填哪几格决定。
 *
 * 以前是按平台名一个个写死，写死就漏：新平台上线的第一次必漏（qiniu、
 * xinghuo 各漏过一次）。现在那张表是凭据的形状（几格、每格是什么），表里有
 * 这一类才给入口。
 */
describe('凭据的入口按这一类的格子给', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 一个平台（这一类要填哪几格，面板自己知道，不问后端怎么登录）。 */
  function kindsClient(
    list: ReturnType<typeof upstream>[],
    sent?: string[][]
  ) {
    return mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams: list }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () => create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent?.push(input.keys ?? [])
        return create(SetProviderKeysResponseSchema)
      },
    })
  }

  it('这一类要填 key：账号行给「API Key」按钮', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: kindsClient([
        upstream('xinghuo', 'xinghuo', '讯飞星火', [
          accountOf('xinghuo-1', 'xinghuo', '星火一'),
        ]),
      ]),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 xinghuo 的账号与凭据' })
    )

    const row = (await screen.findByText('星火一')).closest('tr')
    expect(
      within(row as HTMLElement).getByRole('button', { name: 'API Key' })
    ).toBeInTheDocument()
  })

  it('这一类不用填 key（凭据是登录会话）：不给「API Key」按钮', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: kindsClient([
        upstream('qoder', 'qoder', 'Qoder', [
          accountOf('qoder-1', 'qoder', '邱德'),
        ]),
      ]),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qoder 的账号与凭据' })
    )

    const row = (await screen.findByText('邱德')).closest('tr')
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'API Key' })
    ).not.toBeInTheDocument()
    // 控制组：登录按钮还在，只是不给填 key 的入口。
    expect(
      within(row as HTMLElement).getByRole('button', { name: '登录' })
    ).toBeInTheDocument()
  })

  it('会话型的四家（MiniMax / Qoder / WorkBuddy / ZCode）都不给填 key 的入口', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: kindsClient([
        upstream('minimax', 'minimax', 'MiniMax Code', [
          accountOf('minimax-1', 'minimax', '主账号'),
        ]),
        upstream('qoder', 'qoder', 'Qoder', [
          accountOf('qoder-1', 'qoder', '邱德'),
        ]),
        upstream('workbuddy', 'workbuddy', 'WorkBuddy', [
          accountOf('workbuddy-1', 'workbuddy', '打工人'),
        ]),
        upstream('zcode', 'zcode', 'ZCode', [
          accountOf('zcode-1', 'zcode', '写代码的'),
        ]),
      ]),
      children: <UpstreamsPage />,
    })

    for (const id of ['minimax', 'qoder', 'workbuddy', 'zcode']) {
      await user.click(
        await screen.findByRole('button', { name: `展开 ${id} 的账号与凭据` })
      )
    }

    // 四家都不给「API Key」/「凭据」那个入口：它们的凭据是登录会话。
    expect(
      screen.queryByRole('button', { name: 'API Key' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '凭据' })
    ).not.toBeInTheDocument()
  })

  it('MiniMax Code：额度只认会话，不再给「套餐 key」按钮', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: kindsClient([
        upstream('minimax', 'minimax', 'MiniMax Code', [
          accountOf('minimax', 'minimax', '主账号'),
        ]),
      ]),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 minimax 的账号与凭据' })
    )

    const row = (await screen.findByText('主账号')).closest('tr')
    expect(
      within(row as HTMLElement).queryByRole('button', { name: '套餐 key' })
    ).not.toBeInTheDocument()
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'API Key' })
    ).not.toBeInTheDocument()
    // 控制组：登录按钮还在。
    expect(
      within(row as HTMLElement).getByRole('button', { name: '登录' })
    ).toBeInTheDocument()
  })

  it('讯飞星火：一把 key 就够，提交时只传一把', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: kindsClient(
        [
          upstream('xinghuo', 'xinghuo', '讯飞星火', [
            accountOf('xinghuo-1', 'xinghuo', '星火一'),
          ]),
        ],
        sent
      ),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 xinghuo 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))

    expect(await screen.findByText('讯飞星火 API Key')).toBeInTheDocument()
    await user.type(await screen.findByLabelText('推理 Key'), 'sk-xinghuo-one')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-xinghuo-one']])
    })
  })

  it('讯飞星火：留空提交表示清掉那把 key', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: kindsClient(
        [
          upstream('xinghuo', 'xinghuo', '讯飞星火', [
            accountOf('xinghuo-1', 'xinghuo', '星火一'),
          ]),
        ],
        sent
      ),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 xinghuo 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))

    await user.click(await screen.findByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['']])
    })
  })
})

/**
 * 凭据弹窗按平台渲染带标签的格子。
 *
 * 位置就是顺序：SetProviderKeys 的 keys[] 是按位置读的（服务端
 * lib/admin/credentials.ts 就是这么解的），所以断言的是发出去的数组本身 ——
 * 第几格填的什么，数组的第几项就是什么。
 */
describe('凭据弹窗按平台渲染格子', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 一个平台，带着它名下的一个账号。 */
  function platformOf(
    id: string,
    kind: string,
    label: string,
    extra: Partial<
      Omit<MessageInitShape<typeof UpstreamSchema>, '$typeName' | '$unknown'>
    > = {}
  ): Upstream {
    const base: MessageInitShape<typeof UpstreamSchema> = {
      id,
      kind,
      label,
      state: UpstreamState.NO_CREDENTIAL,
      policy: ProviderPolicy.SINGLE,
      policies: [ProviderPolicy.SINGLE],
      accountCount: 1,
      accounts: [accountOf(`${id}-1`, id, '账号一')],
    }
    return create(UpstreamSchema, { ...base, ...extra })
  }

  /** 一个假客户端：把每次提交的 keys 记下来（按位置，一个不差）。 */
  function clientOf(
    upstream: Upstream,
    sent: string[][],
    plugins: QuotaPlugin[] = []
  ) {
    return mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [upstream] }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      ListQuotaPlugins: () =>
        create(ListQuotaPluginsResponseSchema, { plugins }),
      // 删平台之前要扫一遍主路由模型。
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, { models: [] }),
      SetProviderKeys: (input) => {
        const keys = [...(input.keys ?? [])]
        sent.push(keys)
        return create(SetProviderKeysResponseSchema, {
          count: keys.length,
        })
      },
    })
  }

  /** 展开平台，点开凭据弹窗。 */
  async function openDialog(
    user: ReturnType<typeof userEvent.setup>,
    upstreamId: string
  ) {
    await user.click(
      await screen.findByRole('button', {
        name: `展开 ${upstreamId} 的账号与凭据`,
      })
    )
    await user.click(
      await screen.findByRole('button', { name: /^(凭据|API Key)$/ })
    )
    await screen.findByRole('dialog')
  }

  it('SenseNova：一格「推理 Key」，发出去一把', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('sensenova', 'sensenova', 'SenseNova'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'sensenova')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    await user.type(screen.getByLabelText('推理 Key'), 'sk-sense-1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-sense-1']])
    })
  })

  it('书生·端砚：一格「推理 Key」，发出去一把', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('intern-ai', 'intern-ai', '书生·端砚'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'intern-ai')

    expect(
      await screen.findByLabelText('推理 Key')
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText('推理 Key'), 'sk-disc')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-disc']])
    })
  })

  it('书生·端砚：全空提交：一把空串发上去（清掉那把 key）', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('intern-ai', 'intern-ai', '书生·端砚'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'intern-ai')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['']])
    })
  })

  it('TokenRhythm：一格「推理 Key」，发出去一把', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('tokenrhythm', 'tokenrhythm', 'TokenRhythm'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'tokenrhythm')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    await user.type(screen.getByLabelText('推理 Key'), 'sk-tr-1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-tr-1']])
    })
  })

  it('TokenRhythm：全空提交：一把空串发上去（清掉那把 key）', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('tokenrhythm', 'tokenrhythm', 'TokenRhythm'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'tokenrhythm')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['']])
    })
  })

  it('开放平台：推理 key 在前，插件的那几段按 fields 的顺序在后', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []
    const plugins = [
      create(QuotaPluginSchema, {
        id: 'demo-plugin',
        label: '演示插件',
        fields: [
          create(QuotaPluginFieldSchema, {
            name: 'first',
            label: '第一段',
            secret: true,
          }),
          create(QuotaPluginFieldSchema, {
            name: 'second',
            label: '第二段',
            secret: false,
          }),
        ],
      }),
    ]

    renderWithClient({
      client: clientOf(
        platformOf('my-open', 'openai', '我的开放平台', {
          isOpenPlatform: true,
          quotaPlugin: 'demo-plugin',
        }),
        sent,
        plugins
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'my-open')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    expect(await screen.findByLabelText('第一段')).toBeInTheDocument()
    expect(await screen.findByLabelText('第二段')).toBeInTheDocument()

    await user.type(screen.getByLabelText('推理 Key'), 'sk-infer')
    await user.type(screen.getByLabelText('第一段'), 'v1')
    await user.type(screen.getByLabelText('第二段'), 'v2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer', 'v1', 'v2']])
    })
  })

  it('开放平台：插件那一格的名字就是契约里的 label（不是插件的描述性叫法，也不是 name）', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []
    // 七牛那个插件的真形状（lib/qiniu/quota-plugin.ts 的声明）：名字只有那一处
    // 产出，经 ListQuotaPlugins 原样到面板。面板不拿 name 兜，也不自己编中文。
    const plugins = [
      create(QuotaPluginSchema, {
        id: 'qiniu',
        label: '七牛云资源包',
        fields: [
          create(QuotaPluginFieldSchema, {
            name: 'account',
            label: '额度 Cookie',
            secret: true,
          }),
        ],
      }),
    ]

    renderWithClient({
      client: clientOf(
        platformOf('my-open', 'openai', '我的开放平台', {
          isOpenPlatform: true,
          quotaPlugin: 'qiniu',
        }),
        sent,
        plugins
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'my-open')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    expect(await screen.findByLabelText('额度 Cookie')).toBeInTheDocument()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toContain('门户 cookie')
    expect(dialog.textContent).not.toContain('account')

    await user.type(screen.getByLabelText('推理 Key'), 'sk-infer')
    await user.type(screen.getByLabelText('额度 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer', 'c=1']])
    })
  })

  it('开放平台：没选插件：只有推理那一格', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('my-open', 'openai', '我的开放平台', {
          isOpenPlatform: true,
          quotaPlugin: '',
        }),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'my-open')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    // 只有一格：没有插件的那几段。
    expect(
      screen.queryByLabelText('第一段')
    ).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('推理 Key'), 'sk-infer')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer']])
    })
  })

  it('开放平台：插件没登记：也只有推理那一格', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('my-open', 'openai', '我的开放平台', {
          isOpenPlatform: true,
          quotaPlugin: 'not-registered',
        }),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'my-open')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()

    await user.type(screen.getByLabelText('推理 Key'), 'sk-infer')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer']])
    })
  })

  it('开放平台：插件不要额外的凭据（额度走登录会话）：只有推理那一格', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('my-open', 'openai', '我的开放平台', {
          isOpenPlatform: true,
          quotaPlugin: 'sensenova-pools',
        }),
        sent,
        [
          create(QuotaPluginSchema, {
            id: 'sensenova-pools',
            label: 'SenseNova 积分池',
            // 额度用的是登录会话，不另填凭据。
            fields: [],
          }),
        ]
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'my-open')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    // 格子总数说准：推理那一格，加上插件那段（零段）。
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelectorAll('input')).toHaveLength(1)

    await user.type(screen.getByLabelText('推理 Key'), 'sk-infer')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer']])
    })
  })

  it('SenseNova：选出额度插件也不往上加格子（仍是一格）', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('sensenova', 'sensenova', 'SenseNova'),
        sent,
        [
          create(QuotaPluginSchema, {
            id: 'sensenova-pools',
            label: 'SenseNova 积分池',
            fields: [],
          }),
        ]
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'sensenova')

    expect(await screen.findByLabelText('推理 Key')).toBeInTheDocument()
    const dialog = await screen.findByRole('dialog')
    // 一格：额度插件那段不往上加格子。
    expect(dialog.querySelectorAll('input')).toHaveLength(1)

    await user.type(screen.getByLabelText('推理 Key'), 'sk-sense-1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-sense-1']])
    })
  })

  it('那个「每行一把」的文本框没有了：弹窗里只有带标签的格子', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: clientOf(
        platformOf('intern-ai', 'intern-ai', '书生·端砚'),
        sent
      ),
      children: <UpstreamsPage />,
    })

    await openDialog(user, 'intern-ai')

    // 文本框（textarea）在无障碍树里是 textbox：这里一个都没有。
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('key（每行一把）')
    ).not.toBeInTheDocument()
  })
})

/**
 * 开放平台的凭据格子数由额度插件登记表说了算。
 *
 * 登记表没到手的时候，面板只知道有「推理 API Key」那一格。这时候开弹窗，用户
 * 一保存就发上去一个长度 1 的 keys 数组，而服务端 setProviderKeys 是按位置
 * 写的（keys[i+1] ?? ""）—— 插件那几段就被当成空串清掉了。那是静默的数据
 * 丢失，不是显示问题。所以登记表没到手就不给开那个弹窗。
 */
describe('开放平台的凭据入口：登记表没到手就不给开', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 额度插件登记表那个 RPC 的处理器。 */
  type PluginsHandler = NonNullable<
    Parameters<typeof mockAdminClient>[0]['ListQuotaPlugins']
  >

  /** 一个开放平台：选了「演示插件」，那个插件要两段凭据。 */
  function openPlatform(): Upstream {
    return create(UpstreamSchema, {
      id: 'my-open',
      kind: 'openai',
      label: '我的开放平台',
      state: UpstreamState.NO_CREDENTIAL,
      policy: ProviderPolicy.SINGLE,
      policies: [ProviderPolicy.SINGLE],
      accountCount: 1,
      accounts: [accountOf('my-open-1', 'my-open', '账号一')],
      isOpenPlatform: true,
      quotaPlugin: 'demo-plugin',
    })
  }

  /** 一个假客户端：额度插件登记表按给的处理器来。 */
  function openClient(listPlugins: PluginsHandler) {
    return mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [openPlatform()] }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
    ListQuotaPlugins: listPlugins,
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, { models: [] }),
    SetProviderKeys: () => create(SetProviderKeysResponseSchema),
    })
  }

  /** 展开开放平台那一行。 */
  async function expand(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole('button', {
        name: '展开 my-open 的账号与凭据',
      })
    )
  }

  it('插件列表还在加载：凭据入口是禁用的，弹窗开不了', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      // 一直不回的登记表：这个查询就永远在加载中。
      client: openClient(() => new Promise<never>(() => {})),
      children: <UpstreamsPage />,
    })

    await expand(user)

    // 入口的名字随格子数变（「凭据」还是「API Key」），这里不挑名字：挑的是
    // 它点不了。
    const button = await screen.findByRole('button', {
      name: /^(凭据|API Key)$/,
    })
    // 不能点：点下去就少几段。
    expect(button).toBeDisabled()
    // 也看得见为什么点不了。
    expect(screen.getByText('凭据格子还在加载')).toBeInTheDocument()

    await user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('插件列表取不到：显示错误，凭据入口是禁用的', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: openClient(() => {
        throw new ConnectError('连接被拒', Code.Unavailable)
      }),
      children: <UpstreamsPage />,
    })

    await expand(user)

    const button = await screen.findByRole('button', {
      name: /^(凭据|API Key)$/,
    })
    await waitFor(() => {
      expect(button).toBeDisabled()
    })
    // 错误照出来：不让格子数悄悄变少。
    expect(
      await screen.findByText(/插件列表取不到/)
    ).toBeInTheDocument()

    await user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('模板平台不看登记表：登记表没到手，入口照常给', async () => {
    const user = userEvent.setup({ delay: null })

    renderWithClient({
      client: mockAdminClient({
      ListProviderKinds: listProviderKinds,
        ListUpstreams: () =>
          create(ListUpstreamsResponseSchema, {
            upstreams: [
              create(UpstreamSchema, {
                id: 'qiniu',
                kind: 'qiniu',
                label: '七牛云',
                state: UpstreamState.NO_CREDENTIAL,
                policy: ProviderPolicy.SINGLE,
                policies: [ProviderPolicy.SINGLE],
                accountCount: 1,
                accounts: [qiniuAccount()],
              }),
            ],
          }),
        ListAccounts: () =>
          create(ListAccountsResponseSchema, { accounts: [] }),
        ListCredentials: () =>
          create(ListCredentialsResponseSchema, { credentials: [] }),
        ListQuotaPlugins: () => new Promise<never>(() => {}),
      }),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 qiniu 的账号与凭据',
      })
    )

    // 模板平台的格子是写死的，不看登记表：入口照常给，弹窗也照常开。
    const button = await screen.findByRole('button', { name: '凭据' })
    expect(button).not.toBeDisabled()
    await user.click(button)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByLabelText('额度 Cookie')).toBeInTheDocument()
  })
})
