import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  AddAccountResponseSchema,
  DeletePlatformResponseSchema,
  DeletePublishedModelResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  PublishedModelSchema,
  PublishedTargetSchema,
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

/** 一个开放平台（面板上加的那一行）：能改能删。 */
function openPlatform(
  overrides: Partial<MessageInitShape<typeof UpstreamSchema>> = {}
) {
  const base: MessageInitShape<typeof UpstreamSchema> = {
    id: 'my-gateway',
    kind: 'openai',
    label: '我的中转站',
    region: '',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 0,
    hasEnabledAccount: false,
    baseUrl: 'https://api.example.com/v1',
    isOpenPlatform: true,
    accounts: [],
  }
  return create(UpstreamSchema, Object.assign(base, overrides))
}

/** 一个主路由模型，它的目标指向某个平台。 */
function publishedModel(
  id: string,
  groupName: string,
  displayName = ''
) {
  return create(PublishedModelSchema, {
    id,
    displayName,
    enabled: true,
    published: true,
    targets: [
      create(PublishedTargetSchema, {
        groupName,
        upstreamModel: 'gpt-4o',
        weight: 1,
        enabled: true,
      }),
    ],
  })
}

/** 一个只有平台列表的假客户端：账号相关的请求按空答复。 */
function clientWith(
  upstreams: Upstream[],
  extra: Partial<Parameters<typeof mockAdminClient>[0]> = {}
) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, { upstreams }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, { models: [] }),
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
    expect(within(dialog).getByText(/客户端地址不变/)).toBeInTheDocument()

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

describe('删平台之前先扫主路由引用', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 开放平台那一行。 */
  function rowOf(name: string): HTMLElement {
    const cell = screen.getByText(name).closest('tr')
    if (!cell) throw new Error(`找不到 ${name} 那一行`)
    return cell
  }

  /** 删平台那一行的「删掉」按钮。 */
  function deleteButton(): HTMLElement {
    return within(rowOf('我的中转站')).getByRole('button', { name: '删掉' })
  }

  it('没有模型指向它：确认后只发 DeletePlatform', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 扫描还没回来之前删除入口是禁用的：等它开。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    await waitFor(() => {
      expect(sent).toEqual(['platform:my-gateway'])
    })
  })

  it('有模型指向它：弹框里列出来，确认后先删模型再删平台', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [publishedModel('gpt-4o', 'my-gateway', 'GPT-4o')],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 扫描还没回来之前删除入口是禁用的：等它开。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    // 弹框里把那个模型列出来：id 与显示名。
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('gpt-4o')).toBeInTheDocument()
    expect(within(confirm).getByText(/GPT-4o/)).toBeInTheDocument()
    expect(
      within(confirm).getByText(/这些主路由模型会一起删掉/)
    ).toBeInTheDocument()

    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    await waitFor(() => {
      // 顺序：先删模型，再删平台。
      expect(sent).toEqual(['model:gpt-4o', 'platform:my-gateway'])
    })
  })

  it('有两个模型指向它：两个都删掉，再删平台', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            publishedModel('gpt-4o', 'my-gateway', 'GPT-4o'),
            publishedModel('claude-3', 'my-gateway', 'Claude 3'),
          ],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 扫描还没回来之前删除入口是禁用的：等它开。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('gpt-4o')).toBeInTheDocument()
    expect(within(confirm).getByText('claude-3')).toBeInTheDocument()

    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    await waitFor(() => {
      expect(sent).toEqual([
        'model:gpt-4o',
        'model:claude-3',
        'platform:my-gateway',
      ])
    })
  })

  it('取消：一个都不发', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [publishedModel('gpt-4o', 'my-gateway', 'GPT-4o')],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 扫描还没回来之前删除入口是禁用的：等它开。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(sent).toEqual([])
  })

  it('模型删失败：停在半路，不删平台，失败显示出来', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [publishedModel('gpt-4o', 'my-gateway', 'GPT-4o')],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        return create(DeletePublishedModelResponseSchema, {
          ok: false,
          message: '这个模型正被别的路由用着',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 扫描还没回来之前删除入口是禁用的：等它开。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    // 失败显示出来。
    expect(
      await within(confirm).findByText(/这个模型正被别的路由用着/)
    ).toBeInTheDocument()
    // 平台没删。
    expect(sent).toEqual(['model:gpt-4o'])
  })

  it('删到一半失败：已经删掉的不再重试，剩下的是下一个', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    // claude-3 第一次删不掉，gpt-4o 删得掉。
    let claudeFails = true
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            publishedModel('gpt-4o', 'my-gateway', 'GPT-4o'),
            publishedModel('claude-3', 'my-gateway', 'Claude 3'),
          ],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        if ((input.id ?? '') === 'claude-3' && claudeFails) {
          claudeFails = false
          return create(DeletePublishedModelResponseSchema, {
            ok: false,
            message: '这个模型正被别的路由用着',
          })
        }
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    // 第一个删掉了，第二个失败：平台没删。
    await waitFor(() => {
      expect(sent).toEqual(['model:gpt-4o', 'model:claude-3'])
    })
    expect(
      await within(confirm).findByText(/这个模型正被别的路由用着/)
    ).toBeInTheDocument()

    // 再试一次：只删还没删掉的那一个（gpt-4o 已经没了，不再动它）。
    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    await waitFor(() => {
      expect(sent).toEqual([
        'model:gpt-4o',
        'model:claude-3',
        'model:claude-3',
        'platform:my-gateway',
      ])
    })
  })

  it('删到一半失败：取消后重开，只删还没删掉的那个', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    // claude-3 第一次删不掉（第二次能删掉），gpt-4o 删得掉。
    let claudeFails = true
    const client = clientWith([openPlatform()], {
      // 名单一直带着 gpt-4o：模拟模型删掉之后、重取回来之前的那段时间
      // （面板手上还是旧名单）。
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            publishedModel('gpt-4o', 'my-gateway', 'GPT-4o'),
            publishedModel('claude-3', 'my-gateway', 'Claude 3'),
          ],
        }),
      DeletePublishedModel: (input) => {
        sent.push(`model:${input.id ?? ''}`)
        if ((input.id ?? '') === 'claude-3' && claudeFails) {
          claudeFails = false
          return create(DeletePublishedModelResponseSchema, {
            ok: false,
            message: '这个模型正被别的路由用着',
          })
        }
        return create(DeletePublishedModelResponseSchema, {
          ok: true,
          message: '删掉了',
        })
      },
      DeletePlatform: (input) => {
        sent.push(`platform:${input.id ?? ''}`)
        return create(DeletePlatformResponseSchema, { ok: true, message: '删掉了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    await user.click(deleteButton())

    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删掉' }))

    // 第一个删掉了，第二个失败：弹框留着。
    await waitFor(() => {
      expect(sent).toEqual(['model:gpt-4o', 'model:claude-3'])
    })
    expect(
      await within(confirm).findByText(/这个模型正被别的路由用着/)
    ).toBeInTheDocument()

    // 取消，再点开：已经删掉的那个不该再回到队列里。
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    await user.click(deleteButton())

    const again = await screen.findByRole('alertdialog')
    // 弹框里列的应该只有还没删掉的那几个（确认之后弹框就关了，先记下来）。
    const listed = within(again)
      .queryAllByText(/^(gpt-4o|claude-3)$/)
      .map((node) => node.textContent)

    await user.click(within(again).getByRole('button', { name: '删掉' }))

    // 只发还没删掉的那个：gpt-4o 不再发一遍。
    await waitFor(() => {
      expect(sent).toEqual([
        'model:gpt-4o',
        'model:claude-3',
        'model:claude-3',
        'platform:my-gateway',
      ])
    })
    expect(listed).toEqual(['claude-3'])
  })

  it('主路由模型列表还在查：删除入口不可用', async () => {
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () => new Promise<never>(() => {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(deleteButton()).toBeDisabled()
    expect(
      screen.getByText(/还在查哪些主路由模型指向它/)
    ).toBeInTheDocument()
  })

  it('主路由模型列表取不到：删除入口不可用，显示出原因', async () => {
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () => {
        throw new Error('网关炸了')
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(await screen.findByText(/查不到主路由模型/)).toBeInTheDocument()
    expect(deleteButton()).toBeDisabled()
  })

  it('主路由模型列表取不到：可以重扫一次', async () => {
    const user = userEvent.setup({ delay: null })
    let scans = 0
    const client = clientWith([openPlatform()], {
      ListPublishedModels: () => {
        scans += 1
        if (scans === 1) throw new Error('网关炸了')
        return create(ListPublishedModelsResponseSchema, { models: [] })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(await screen.findByText(/查不到主路由模型/)).toBeInTheDocument()
    expect(scans).toBe(1)

    // 重试入口：点它重扫一次。
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '重试' })
    )

    await waitFor(() => {
      expect(scans).toBe(2)
    })
    // 扫回来了：删除入口开了。
    await waitFor(() => expect(deleteButton()).toBeEnabled())
  })
})
