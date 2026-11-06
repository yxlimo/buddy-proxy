import { create, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AddPlatformResponseSchema,
  CreditSummarySchema,
  DeletePlatformResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListPlatformKindsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  OpenPlatformSchema,
  PlatformKindSchema,
  ProviderPolicy,
  QuotaPluginFieldSchema,
  QuotaPluginSchema,
  RefreshPlatformModelsResponseSchema,
  UpdatePlatformResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { PLATFORM_TEMPLATES } from '@/features/open-platforms/templates'
import { formatLocalMoment } from '@/lib/format'
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

/** 服务端报的上次拉取时刻。 */
const FETCHED_AT = BigInt(Date.UTC(2026, 10, 3, 4, 0, 0))

/**
 * 服务端登记的两种方言：顺序与服务端那张表一样。
 *
 * 面板不写死这两条（清单是服务端给的），这里只是把服务端现在给的那两条摆上。
 */
function twoKinds() {
  return [
    create(PlatformKindSchema, {
      kind: 'openai',
      label: 'OpenAI 兼容',
      defaultBaseUrl: '',
      modelsFromUpstream: true,
    }),
    create(PlatformKindSchema, {
      kind: 'anthropic',
      label: 'Anthropic 兼容',
      defaultBaseUrl: '',
      modelsFromUpstream: true,
    }),
  ]
}

/**
 * 模拟客户端平台：表里有行（能改能删），但不只是一个开放平台。
 */
function template(
  overrides: Partial<MessageInitShape<typeof UpstreamSchema>> = {}
): Upstream {
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
    fromRow: true,
    accounts: [],
  }
  return create(UpstreamSchema, Object.assign(base, overrides))
}

/** 表里的开放平台：能改能删。 */
function openPlatform(
  overrides: Partial<MessageInitShape<typeof UpstreamSchema>> = {}
): Upstream {
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
    // 这几格都不是零值：平台本来选着插件、开着自动拉、有一份目录。面板要是
    // 把它们静默清空了，测试得看得出来（零值的话看不出来）。
    quotaPlugin: 'qiniu-portal',
    modelsAuto: true,
    models: ['gpt-4o', 'claude-3'],
    modelsSource: 'auto',
    modelsFetchedAtMs: FETCHED_AT,
    isOpenPlatform: true,
    // 开放平台的目录归上游：卡片上有「刷新模型目录」。
    modelsFromUpstream: true,
    fromRow: true,
    accounts: [],
  }
  return create(UpstreamSchema, Object.assign(base, overrides))
}

/** 一个只有平台列表的假客户端：其余请求按空答复。 */
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
    ListQuotaPlugins: () =>
      create(ListQuotaPluginsResponseSchema, { plugins: [] }),
    // 建平台时能选的类型：服务端现在给的那两条。
    ListPlatformKinds: () =>
      create(ListPlatformKindsResponseSchema, { kinds: twoKinds() }),
    // 删平台之前要扫一遍主路由模型：没有模型指向它才是平常那条路。
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, { models: [] }),
    ...extra,
  })
}

/** 开放平台那一行。 */
function rowOf(name: string): HTMLElement {
  const cell = screen.getByText(name).closest('tr')
  if (!cell) throw new Error(`找不到 ${name} 那一行`)
  return cell
}

/**
 * 一个还没落定的 promise：把「清单还在加载」这一档摆稳，手后再放行。
 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * 服务端登记的四个额度插件。
 *
 * 名字用插件自己的 label：面板不自己给插件起名字。四家的 fields 都是空的
 * （额度走登录会话，不另填凭据）。
 */
function fourPlugins() {
  return [
    create(QuotaPluginSchema, {
      id: 'qiniu-portal',
      label: '七牛门户',
      fields: [],
    }),
    create(QuotaPluginSchema, {
      id: 'sensenova-pools',
      label: 'SenseNova 积分池',
      fields: [],
    }),
    create(QuotaPluginSchema, {
      id: 'tokenrhythm-wallet',
      label: 'TokenRhythm 钱包',
      fields: [],
    }),
    create(QuotaPluginSchema, {
      id: 'intern-ai-credits',
      label: '书生·端砚 墨点',
      fields: [],
    }),
  ]
}

/** 一个假客户端：ListQuotaPlugins 给四个插件，UpdatePlatform 记下插件 id。 */
function editingClient(
  platform: Upstream,
  sent: string[],
  plugins = fourPlugins()
) {
  return clientWith([platform], {
    ListQuotaPlugins: () =>
      create(ListQuotaPluginsResponseSchema, { plugins }),
    UpdatePlatform: (input) => {
      sent.push(input.quotaPlugin ?? '')
      return create(UpdatePlatformResponseSchema, {
        platform: create(OpenPlatformSchema, {
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          quotaPlugin: input.quotaPlugin ?? '',
          modelsAuto: input.modelsAuto,
        }),
      })
    },
  })
}

/** 打开某个平台的「编辑」弹窗。 */
async function openEdit(
  user: ReturnType<typeof userEvent.setup>,
  name: string
): Promise<HTMLElement> {
  await screen.findByText(name)
  await user.click(within(rowOf(name)).getByRole('button', { name: '编辑' }))
  return await screen.findByRole('dialog')
}

/**
 * 把一个新平台的三格填成能提交的。
 *
 * 三格都是必填的：那把保存按钮提前置灰的判据就是它们（地址空着就不发请求）。
 */
async function fillNewPlatform(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  id: string
) {
  await user.type(within(dialog).getByLabelText('平台 id'), id)
  await user.type(within(dialog).getByLabelText('名字'), '我的中转站')
  await user.type(
    within(dialog).getByLabelText('地址'),
    'https://api.example.com/v1'
  )
}

describe('面板上的开放平台', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('「新增平台」入口：填 id、名字、地址，发的是 AddPlatform', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; label: string; baseUrl: string; kind: string }[] = []
    const client = clientWith([], {
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
        })
        return create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-gateway')
    await user.type(within(dialog).getByLabelText('名字'), '我的中转站')
    await user.type(
      within(dialog).getByLabelText('地址'),
      'https://api.example.com/v1'
    )
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-gateway',
          label: '我的中转站',
          baseUrl: 'https://api.example.com/v1',
          kind: 'openai',
        },
      ])
    })
  })

  it('新建平台：额度插件按类型预填，请求里带上 quota_plugin', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: {
      id: string
      label: string
      baseUrl: string
      kind: string
      quotaPlugin?: string
    }[] = []
    const client = clientWith([], {
      // 服务端给的类型清单：七牛云这一类有默认地址与默认额度插件。
      ListPlatformKinds: () =>
        create(ListPlatformKindsResponseSchema, {
          kinds: [
            ...twoKinds(),
            create(PlatformKindSchema, {
              kind: 'qiniu',
              label: '七牛云',
              category: 'dialect',
              defaultBaseUrl: 'https://api.qnaigc.com/v1',
              defaultQuotaPlugin: 'qiniu-portal',
              modelsFromUpstream: false,
            }),
          ],
        }),
      ListQuotaPlugins: () =>
        create(ListQuotaPluginsResponseSchema, { plugins: fourPlugins() }),
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
          quotaPlugin: input.quotaPlugin,
        })
        return create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')
    // 类型选七牛云：地址与额度插件都按这一类预填。
    await user.click(within(dialog).getByRole('combobox', { name: '类型' }))
    await user.click(await screen.findByRole('option', { name: '七牛云' }))
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-qiniu')
    await user.type(within(dialog).getByLabelText('名字'), '我的七牛')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 预填的那一格真的在请求体里。
    expect(sent[0].quotaPlugin).toBe('qiniu-portal')
    expect(sent[0].baseUrl).toBe('https://api.qnaigc.com/v1')
    expect(sent[0].kind).toBe('qiniu')
  })

  it('新增成功：弹窗关掉', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([], {
      AddPlatform: (input) =>
        create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    await fillNewPlatform(user, dialog, 'my-gateway')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('面板放行了、服务端仍然拒：它那句话原样显示，弹窗不关', async () => {
    const user = userEvent.setup({ delay: null })
    // 三格在面板这一侧都是合法的：这条错误只有服务端知道（它认得的比面板多）。
    // 面板只负责把服务端那句话摆出来，不替它另写一句。
    const client = clientWith([], {
      AddPlatform: () => {
        throw new ConnectError('这个地址上游不认', Code.InvalidArgument)
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    await fillNewPlatform(user, dialog, 'my-gateway')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    // 服务端那句话原样显示。
    expect(
      await within(dialog).findByText(/参数不合法：这个地址上游不认/)
    ).toBeInTheDocument()
    // 弹窗不关：还得改。
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('开放平台显示地址、模型来源、额度插件名；模拟客户端不摆这两格', async () => {
    const client = clientWith(
      [template(), openPlatform({ quotaPlugin: 'qiniu', modelsAuto: true })],
      {
        ListQuotaPlugins: () =>
          create(ListQuotaPluginsResponseSchema, {
            plugins: [
              create(QuotaPluginSchema, {
                id: 'qiniu',
                label: '七牛云资源包',
                fields: [],
              }),
            ],
          }),
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')

    // 地址：原样显示。
    expect(screen.getByText('https://api.example.com/v1')).toBeInTheDocument()
    // 模型来源：自动拉 / 手动配。
    expect(screen.getByText(/模型目录：自动拉/)).toBeInTheDocument()
    // 额度插件名。
    expect(screen.getByText('额度插件：七牛云资源包')).toBeInTheDocument()

    // 开放平台能改能删。
    const open = rowOf('我的中转站')
    expect(
      within(open).getByRole('button', { name: '编辑' })
    ).toBeInTheDocument()
    expect(
      within(open).getByRole('button', { name: '删除' })
    ).toBeInTheDocument()

    // 模拟客户端：地址与额度插件这两格不摆（归代码）。
    const tmpl = rowOf('MiniMax Code')
    expect(
      within(tmpl).queryByText(/https?:\/\//)
    ).not.toBeInTheDocument()
    expect(
      within(tmpl).queryByText(/额度插件/)
    ).not.toBeInTheDocument()
    // 但表里有它这一行：能改能删。
    expect(
      within(tmpl).getByRole('button', { name: '编辑' })
    ).toBeInTheDocument()
    expect(
      within(tmpl).getByRole('button', { name: '删除' })
    ).toBeInTheDocument()
  })

  it('手动配的模型目录显示模型数', async () => {
    const client = clientWith([
      openPlatform({
        modelsAuto: false,
        modelsSource: 'manual',
        models: ['a', 'b', 'c'],
        modelsFetchedAtMs: 0n,
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(screen.getByText('模型目录：手动配 · 3 个模型')).toBeInTheDocument()
  })

  it('自动拉但没拉过：说没拉过，不说 0 也不说 1970', async () => {
    const client = clientWith([
      openPlatform({ modelsSource: 'auto', modelsFetchedAtMs: 0n }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(
      screen.getByText('模型目录：自动拉 · 上次拉取：没拉过')
    ).toBeInTheDocument()
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
  })

  it('自动拉：显示服务端给的上次拉取时刻', async () => {
    const client = clientWith([openPlatform({ modelsSource: 'auto' })])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(
      screen.getByText(
        `模型目录：自动拉 · 上次拉取：${formatLocalMoment(FETCHED_AT)}`
      )
    ).toBeInTheDocument()
  })

  it('来源是手动（自动开着也不变）：显示手动配', async () => {
    // 人写的目录 + 打开自动：目录本身还是人写的那份。
    const client = clientWith([
      openPlatform({
        modelsAuto: true,
        modelsSource: 'manual',
        models: ['a', 'b'],
        modelsFetchedAtMs: 0n,
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(screen.getByText('模型目录：手动配 · 2 个模型')).toBeInTheDocument()
  })

  it('改平台：发的是 UpdatePlatform，带的是整单', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: Record<string, unknown>[] = []
    const client = clientWith([openPlatform()], {
      UpdatePlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          quotaPlugin: input.quotaPlugin ?? '',
          modelsAuto: input.modelsAuto,
          models: [...(input.models ?? [])],
        })
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
            quotaPlugin: input.quotaPlugin ?? '',
            modelsAuto: input.modelsAuto,
            models: [...(input.models ?? [])],
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )

    const dialog = await screen.findByRole('dialog')
    // 现在的那几格都填着：整单提交要的就是它们。
    expect(within(dialog).getByLabelText('名字')).toHaveValue('我的中转站')
    expect(within(dialog).getByLabelText('地址')).toHaveValue(
      'https://api.example.com/v1'
    )
    // id 改不了。
    expect(within(dialog).getByLabelText('平台 id')).toBeDisabled()
    // 模型目录是平台上那份：刷新了页面也还在。
    expect(within(dialog).getByLabelText('模型目录')).toHaveValue(
      'gpt-4o\nclaude-3'
    )

    await user.clear(within(dialog).getByLabelText('名字'))
    await user.type(within(dialog).getByLabelText('名字'), '新的名字')
    // 把自动拉关掉：目录那一格才能改。
    await user.click(
      within(dialog).getByRole('switch', { name: '自动拉模型目录' })
    )
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-gateway',
          label: '新的名字',
          baseUrl: 'https://api.example.com/v1',
          // 平台原来选着的插件：整单提交要带上，不许静默清空。
          quotaPlugin: 'qiniu-portal',
          // 原来开着自动拉，用户关掉了：带的是关掉这一格。
          modelsAuto: false,
          // 平台上那份目录：原样带上去，不许换成别的。
          models: ['gpt-4o', 'claude-3'],
        },
      ])
    })
  })

  it('改平台：开关没动过就不发这一格，动了才带', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: (boolean | undefined)[] = []
    const client = clientWith([openPlatform()], {
      UpdatePlatform: (input) => {
        // optional bool 的「没给」与「给了 false」不是一回事：这里抄原值，不补默认。
        sent.push(input.traitsFromCommon)
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    // 第一次：只改名字，开关没碰过。
    const dialog = await openEdit(user, '我的中转站')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toBeUndefined()

    // 第二次：拨开开关。
    const again = await openEdit(user, '我的中转站')
    await user.click(
      within(again).getByRole('switch', { name: '用共性表补模型参数' })
    )
    await user.click(within(again).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toBe(true)
  })

  it('改平台：请求里没有 kind（整份入参逐字段对）', async () => {
    const user = userEvent.setup({ delay: null })
    // 把 UpdatePlatform 的入参整份抄下来逐字段对：契约里没有 kind 这一格，
    // 面板多带一格就是发错了。
    const sent: Record<string, unknown>[] = []
    const client = clientWith([openPlatform()], {
      UpdatePlatform: (input) => {
        const whole: Record<string, unknown> = {
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          quotaPlugin: input.quotaPlugin ?? '',
          modelsAuto: input.modelsAuto,
          models: [...(input.models ?? [])],
        }
        // 弹窗那一单整个递下来的话，这里会多出这一格。
        if ('kind' in (input as object)) {
          whole.kind = (input as unknown as Record<string, unknown>).kind
        }
        sent.push(whole)
        return create(UpdatePlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      id: 'my-gateway',
      label: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      quotaPlugin: 'qiniu-portal',
      // 这个平台开着自动拉：目录不动（不带清单）。
      modelsAuto: true,
      models: [],
    })
    // 多一格都不行。
    expect(sent[0]).not.toHaveProperty('kind')
  })

  it('改平台失败：弹窗里显示服务端那句话，弹窗不关', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform()], {
      UpdatePlatform: () => {
        throw new ConnectError(
          '这个 id 是代码里的平台，改不了',
          Code.FailedPrecondition
        )
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    // 服务端那句话原样显示在弹窗里。
    expect(
      await within(dialog).findByText(/这个 id 是代码里的平台，改不了/)
    ).toBeInTheDocument()
    // 弹窗不关：还得改。
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('改成功：弹窗关掉', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform()], {
      UpdatePlatform: () =>
        create(UpdatePlatformResponseSchema, {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('打开自动拉：只翻那一格，不带目录清单', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: Record<string, unknown>[] = []
    const client = clientWith([openPlatform({ modelsAuto: false, models: [] })], {
      UpdatePlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          quotaPlugin: input.quotaPlugin ?? '',
          modelsAuto: input.modelsAuto,
          models: [...(input.models ?? [])],
        })
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('模型目录'), 'gpt-4o')
    await user.click(
      within(dialog).getByRole('switch', { name: '自动拉模型目录' })
    )
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-gateway',
          label: '我的中转站',
          baseUrl: 'https://api.example.com/v1',
          quotaPlugin: 'qiniu-portal',
          modelsAuto: true,
          // 自动拉的时候不动现在那份目录：不带清单。
          models: [],
        },
      ])
    })
  })

  it('选额度插件：存进 quota_plugin，插件要哪几段凭据只展示', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListQuotaPlugins: () =>
        create(ListQuotaPluginsResponseSchema, {
          plugins: [
            create(QuotaPluginSchema, {
              id: 'qiniu',
              label: '七牛云资源包',
              fields: [
                create(QuotaPluginFieldSchema, {
                  name: 'account',
                  label: '门户 cookie',
                  secret: true,
                }),
              ],
            }),
          ],
        }),
      UpdatePlatform: (input) => {
        sent.push(input.quotaPlugin ?? '')
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
            quotaPlugin: input.quotaPlugin ?? '',
            modelsAuto: input.modelsAuto,
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('combobox'))
    await user.click(
      await screen.findByRole('option', { name: '七牛云资源包' })
    )

    // 这个插件要哪几段凭据：只展示，不填。
    expect(
      within(dialog).getByText('这个插件要这几段凭据')
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/门户 cookie/)).toBeInTheDocument()
    // 没有填凭据的输入框。
    expect(
      within(dialog).queryByLabelText(/门户 cookie/)
    ).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['qiniu'])
    })
  })

  it('额度插件下拉：登记表里的四个都列得出来，加一项「不用插件」', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = editingClient(
      openPlatform({ quotaPlugin: 'tokenrhythm-wallet' }),
      sent
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    // 当前选中的那个：显示的是插件自己的 label，不是 id。
    const trigger = within(dialog).getByRole('combobox')
    await waitFor(() => {
      expect(trigger).toHaveTextContent('TokenRhythm 钱包')
    })

    await user.click(trigger)
    for (const label of [
      '七牛门户',
      'SenseNova 积分池',
      'TokenRhythm 钱包',
      '书生·端砚 墨点',
      '不用插件',
    ]) {
      expect(await screen.findByRole('option', { name: label })).toBeInTheDocument()
    }
    // 四个插件加「不用插件」：不多不少。
    expect(screen.getAllByRole('option')).toHaveLength(5)
  })

  it('选「不用插件」：提交的是空串', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = editingClient(openPlatform(), sent)

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')
    await user.click(within(dialog).getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: '不用插件' }))
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([''])
    })
  })

  it('存着的插件不在已知插件里：显示「未知插件 <id>」并提示，提交原样带上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = editingClient(
      openPlatform({ quotaPlugin: 'gone-plugin' }),
      sent
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    // 不能被静默改写成第一项：下拉框里显示的是存着的那个 id。
    await waitFor(() => {
      expect(within(dialog).getByRole('combobox')).toHaveTextContent(
        '未知插件 gone-plugin'
      )
    })
    expect(
      within(dialog).getByText(/不在已知插件里/)
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['gone-plugin'])
    })
  })

  it('插件列表还在加载：说还在加载，不说这个 id 不在已知插件里', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      // 一直不回来：登记表就是「加载中」那一档。
      ListQuotaPlugins: () => new Promise(() => {}),
      UpdatePlatform: (input) => {
        sent.push(input.quotaPlugin ?? '')
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
            quotaPlugin: input.quotaPlugin ?? '',
            modelsAuto: input.modelsAuto,
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    await waitFor(() => {
      expect(within(dialog).getByRole('combobox')).toHaveTextContent(
        'qiniu-portal（列表还在加载）'
      )
    })
    expect(
      within(dialog).getByText(/^插件列表还在加载/)
    ).toBeInTheDocument()
    // 列表没到手的时候「不在已知插件里」这个判断不成立：不能把登记过的说成填错了。
    expect(
      within(dialog).queryByText(/不在已知插件里/)
    ).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['qiniu-portal'])
    })
  })

  it('插件列表取不到：已登记的 id 不说成「未知插件」', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      ListQuotaPlugins: () => {
        throw new ConnectError('问不到', Code.Unavailable)
      },
      UpdatePlatform: (input) => {
        sent.push(input.quotaPlugin ?? '')
        return create(UpdatePlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
            quotaPlugin: input.quotaPlugin ?? '',
            modelsAuto: input.modelsAuto,
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    await waitFor(() => {
      expect(within(dialog).getByRole('combobox')).toHaveTextContent(
        'qiniu-portal（列表取不到）'
      )
    })
    expect(
      within(dialog).getByText(/插件列表取不到/)
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['qiniu-portal'])
    })
  })

  it('刷新模型目录：发的是 RefreshPlatformModels，成功那句由面板按条数说', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform({ modelsAuto: true })], {
      RefreshPlatformModels: (input) => {
        sent.push(input.platformId ?? '')
        return create(RefreshPlatformModelsResponseSchema, {
          ok: true,
          models: ['a', 'b', 'c'],
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', {
        name: '刷新模型目录',
      })
    )

    await waitFor(() => {
      expect(sent).toEqual(['my-gateway'])
    })
    // 成功那句是面板自己说的（条数来自答复里的 models），不摆服务端的 message。
    expect(await screen.findByText(/已刷新，3 个模型/)).toBeInTheDocument()
  })

  it('刷新失败：显示服务端给的原因', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform({ modelsAuto: true })], {
      RefreshPlatformModels: () =>
        create(RefreshPlatformModelsResponseSchema, {
          ok: false,
          message: '拉不到模型目录：还没有能用的 API key',
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', {
        name: '刷新模型目录',
      })
    )

    expect(
      await screen.findByText(/拉不到模型目录：还没有能用的 API key/)
    ).toBeInTheDocument()
  })

  it('删平台：先确认，确认后发 DeletePlatform', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([openPlatform()], {
      DeletePlatform: (input) => {
        sent.push(input.id ?? '')
        return create(DeletePlatformResponseSchema, {
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 删之前要先扫主路由引用：扫完了删除入口才开。
    const del = within(rowOf('我的中转站')).getByRole('button', { name: '删除' })
    await waitFor(() => expect(del).toBeEnabled())
    await user.click(del)

    // 先确认：确认框里说的是这个平台。
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/我的中转站/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(sent).toEqual(['my-gateway'])
    })
  })

  it('删平台失败：显示服务端那句话', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform()], {
      // 失败是一次 Connect 错误（这一族方法没有 ok / message 两格）。
      DeletePlatform: () => {
        throw new ConnectError(
          '这个平台正被主路由引用：my-gateway',
          Code.FailedPrecondition
        )
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    const del = within(rowOf('我的中转站')).getByRole('button', { name: '删除' })
    await waitFor(() => expect(del).toBeEnabled())
    await user.click(del)
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删除' }))

    // 服务端那句话显示出来。
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(String(toastError.mock.calls[0][0])).toContain('正被主路由引用')
  })

  it('额度：没有结论的三种都不显示额度那一栏，也不显示 0', async () => {
    const client = clientWith(
      [
        openPlatform({
          id: 'no-plugin',
          label: '没选插件的',
          quotaPlugin: '',
        }),
        openPlatform({
          id: 'unknown-plugin',
          label: '插件没登记的',
          quotaPlugin: 'nope',
        }),
        openPlatform({
          id: 'no-snapshot',
          label: '还没问到的',
          quotaPlugin: 'qiniu',
        }),
      ],
      {
        // 登记表里有 qiniu：第三行是「登记了但快照里没这份」，不是「没登记」。
        ListQuotaPlugins: () =>
          create(ListQuotaPluginsResponseSchema, {
            plugins: [
              create(QuotaPluginSchema, {
                id: 'qiniu',
                label: '七牛云资源包',
                fields: [],
              }),
            ],
          }),
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('没选插件的')
    // 没有结论就不说额度这一栏：原因在上面那行（额度插件）里已经说了。
    expect(screen.queryByText(/^额度：/)).not.toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()

    // 「不知道」不是一个 0：任何地方都不显示 0 点、0 元。
    expect(screen.queryByText(/0 点/)).not.toBeInTheDocument()
    expect(screen.queryByText(/¥0/)).not.toBeInTheDocument()
    expect(screen.queryByText(/剩 0/)).not.toBeInTheDocument()
  })

  it('额度问到了：显示插件名与它算出来的值', async () => {
    const client = clientWith(
      [
        openPlatform({
          quotaPlugin: 'qiniu',
          quota: create(UpstreamQuotaSchema, {
            credits: create(CreditSummarySchema, {
              total: 2000,
              used: 800,
              remaining: 1200,
            }),
          }),
        }),
      ],
      {
        ListQuotaPlugins: () =>
          create(ListQuotaPluginsResponseSchema, {
            plugins: [
              create(QuotaPluginSchema, {
                id: 'qiniu',
                label: '七牛云资源包',
                fields: [],
              }),
            ],
          }),
      }
    )

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 插件名与它算出来的值。
    expect(screen.getByText('额度：七牛云资源包')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    // 「不知道」的那些格没有出现在这一行上。
    expect(screen.queryByText(/未知/)).not.toBeInTheDocument()
  })

  it('选一条模板：id、名字、地址三格被填上，提交带的是这三格', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; label: string; baseUrl: string; kind: string }[] = []
    const client = clientWith([], {
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
        })
        return create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    const list = within(dialog).getByRole('group', { name: '模板列表' })

    // 88 条里挑一条：先搜，再点。
    await user.type(within(dialog).getByLabelText('搜模板'), 'deepseek')
    await user.click(within(list).getByRole('button', { name: /DeepSeek/ }))

    // 三格被模板填上了。
    expect(within(dialog).getByLabelText('平台 id')).toHaveValue('deepseek')
    expect(within(dialog).getByLabelText('名字')).toHaveValue('DeepSeek')
    expect(within(dialog).getByLabelText('地址')).toHaveValue(
      'https://api.deepseek.com/v1'
    )

    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'deepseek',
          label: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          kind: 'openai',
        },
      ])
    })
  })

  it('选完模板还能改那三格：改完提交的是改过的', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; label: string; baseUrl: string; kind: string }[] = []
    const client = clientWith([], {
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
        })
        return create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    const list = within(dialog).getByRole('group', { name: '模板列表' })

    await user.type(within(dialog).getByLabelText('搜模板'), 'deepseek')
    await user.click(within(list).getByRole('button', { name: /DeepSeek/ }))

    // 模板填的三格都能改：模板是起点。
    await user.clear(within(dialog).getByLabelText('平台 id'))
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-deepseek')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-deepseek',
          label: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          kind: 'openai',
        },
      ])
    })
  })

  it('搜模板：输入 deep，只剩含 deep 的条目', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    const list = within(dialog).getByRole('group', { name: '模板列表' })

    // 没搜之前是整张表。
    expect(within(list).getAllByRole('button')).toHaveLength(88)

    await user.type(within(dialog).getByLabelText('搜模板'), 'deep')

    // 只剩含 deep 的两条。
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(
      within(list).getByRole('button', { name: /DeepInfra/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: /DeepSeek/ })
    ).toBeInTheDocument()
    // 别的条目被过滤掉了。
    expect(
      within(list).queryByRole('button', { name: /OpenAI/ })
    ).not.toBeInTheDocument()
  })

  it('不选模板直接手填：也能加上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; label: string; baseUrl: string; kind: string }[] = []
    const client = clientWith([], {
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
        })
        return create(AddPlatformResponseSchema, {
          platform: create(OpenPlatformSchema, {
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          }),
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    // 模板表在那儿，手填这条路照样走。
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-gateway')
    await user.type(within(dialog).getByLabelText('名字'), '我的中转站')
    await user.type(
      within(dialog).getByLabelText('地址'),
      'https://api.example.com/v1'
    )
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-gateway',
          label: '我的中转站',
          baseUrl: 'https://api.example.com/v1',
          kind: 'openai',
        },
      ])
    })
  })

  it('id 撞了：服务端说已经有这个平台了，那句话显示在表单里，弹窗不关', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([], {
      AddPlatform: () => {
        throw new ConnectError('已经有这个平台了', Code.AlreadyExists)
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    // 面板那份清单里没有 deepseek（它是别人刚建的）：挡不住，服务端来说。
    await fillNewPlatform(user, dialog, 'deepseek')
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    // 服务端那句话照原样显示（describeError 给这一档加的前缀）。
    expect(
      await within(dialog).findByText(/资源已存在：已经有这个平台了/)
    ).toBeInTheDocument()
    // 弹窗不关：还得改。
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

/**
 * 建平台时能选的那一格：类型（方言）。
 *
 * 选项全部来自服务端（ListPlatformKinds）：面板不写死 openai / anthropic 这两条。
 * 清单没到手就不放行提交 —— 不猜一个默认值发上去。
 */
describe('建平台时能选类型', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('默认选第一条；改成第二条后提交，kind 是第二条那一条', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: { id: string; label: string; baseUrl: string; kind: string }[] = []
    const client = clientWith([], {
      AddPlatform: (input) => {
        sent.push({
          id: input.id ?? '',
          label: input.label ?? '',
          baseUrl: input.baseUrl ?? '',
          kind: input.kind ?? '',
        })
        return create(AddPlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    // 清单到手后默认选第一条：显示的是它自己的名字，不是 id。
    const kind = within(dialog).getByRole('combobox', { name: '类型' })
    await waitFor(() => expect(kind).toHaveTextContent('OpenAI 兼容'))

    // 改成第二条。
    await user.click(kind)
    await user.click(
      await screen.findByRole('option', { name: 'Anthropic 兼容' })
    )
    expect(kind).toHaveTextContent('Anthropic 兼容')

    await user.type(within(dialog).getByLabelText('平台 id'), 'my-gateway')
    await user.type(within(dialog).getByLabelText('名字'), '我的中转站')
    await user.type(
      within(dialog).getByLabelText('地址'),
      'https://api.example.com/v1'
    )
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    // 逐格对：kind 是刚选的那一条，其余三格是填进去的。
    await waitFor(() => {
      expect(sent).toEqual([
        {
          id: 'my-gateway',
          label: '我的中转站',
          baseUrl: 'https://api.example.com/v1',
          kind: 'anthropic',
        },
      ])
    })
  })

  it('类型带默认地址：地址空着的时候用它占位，换类型时跟着新类型走', async () => {
    const user = userEvent.setup({ delay: null })
    const kinds = [
      create(PlatformKindSchema, {
        kind: 'openai',
        label: 'OpenAI 兼容',
        defaultBaseUrl: 'https://gw.example.com/v1',
        modelsFromUpstream: true,
      }),
      create(PlatformKindSchema, {
        kind: 'anthropic',
        label: 'Anthropic 兼容',
        defaultBaseUrl: '',
        modelsFromUpstream: true,
      }),
    ]
    const client = clientWith([], {
      ListPlatformKinds: () =>
        create(ListPlatformKindsResponseSchema, { kinds }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    // 默认选中第一条：它的默认地址填进地址那一格。
    const address = within(dialog).getByLabelText('地址')
    await waitFor(() =>
      expect(address).toHaveValue('https://gw.example.com/v1')
    )

    // 换成没有默认地址的那一条：面板预填的那份不算用户填的，跟着新类型走。
    await user.click(within(dialog).getByRole('combobox', { name: '类型' }))
    await user.click(
      await screen.findByRole('option', { name: 'Anthropic 兼容' })
    )
    expect(address).toHaveValue('')
  })

  it('地址是用户自己敲的：换类型时不覆盖它', async () => {
    const user = userEvent.setup({ delay: null })
    const kinds = [
      create(PlatformKindSchema, {
        kind: 'openai',
        label: 'OpenAI 兼容',
        defaultBaseUrl: 'https://gw.example.com/v1',
        modelsFromUpstream: true,
      }),
      create(PlatformKindSchema, {
        kind: 'anthropic',
        label: 'Anthropic 兼容',
        defaultBaseUrl: 'https://anthropic.example.com/v1',
        modelsFromUpstream: true,
      }),
    ]
    const client = clientWith([], {
      ListPlatformKinds: () =>
        create(ListPlatformKindsResponseSchema, { kinds }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    const address = within(dialog).getByLabelText('地址')
    await waitFor(() =>
      expect(address).toHaveValue('https://gw.example.com/v1')
    )
    await user.clear(address)
    await user.type(address, 'https://my-own.example.com/v1')

    // 换一条类型：敲过的地址是用户的值，不覆盖。
    await user.click(within(dialog).getByRole('combobox', { name: '类型' }))
    await user.click(
      await screen.findByRole('option', { name: 'Anthropic 兼容' })
    )
    expect(address).toHaveValue('https://my-own.example.com/v1')
  })

  it('类型清单取不到：选择禁用、说原因，保存禁用，不发请求', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = clientWith([], {
      ListPlatformKinds: () => {
        throw new ConnectError('问不到', Code.Unavailable)
      },
      AddPlatform: (input) => {
        sent.push(input.kind ?? '')
        return create(AddPlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    const kind = within(dialog).getByRole('combobox', { name: '类型' })
    await waitFor(() => expect(kind).toBeDisabled())
    // 取不到的原因照服务端/传输层那句话显示。
    expect(within(dialog).getByText(/类型清单取不到：网关不可用/)).toBeInTheDocument()

    // 填了别的格也不许提交：类型这一格没有值，发上去等于替用户选了一种。
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-gateway')
    const save = within(dialog).getByRole('button', { name: '加上' })
    expect(save).toBeDisabled()
    await user.click(save)

    expect(sent).toEqual([])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('清单还没到手：编辑弹窗与卡片都不显示类型这一行', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform({ kind: 'anthropic' })], {
      // 一直不回来：清单就是「加载中」那一档。
      ListPlatformKinds: () => new Promise(() => {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    // 同一份数据两处说法得一样：弹窗与卡片都不掘这一行，不把 raw kind 摆上去。
    expect(within(dialog).queryByText(/类型：/)).not.toBeInTheDocument()
    expect(screen.queryByText(/类型：/)).not.toBeInTheDocument()
  })

  it('平台没有类型：编辑弹窗也不掘这一行', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform({ kind: '', quotaPlugin: '' })])

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    // 空串不是一种类型：没有可说的事。
    expect(within(dialog).queryByText(/类型：/)).not.toBeInTheDocument()
  })

  it('清单到手但一条也没有：说没有能选的类型，不说还在加载', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([], {
      ListPlatformKinds: () =>
        create(ListPlatformKindsResponseSchema, { kinds: [] }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    // 清单已经到手了：不能再说「还在加载」。占位符与下面那句是同一处给的话。
    expect(
      await within(dialog).findByText('没有能选的类型')
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/还在加载/)).not.toBeInTheDocument()
    // 一个都没得选：保存仍然禁用。
    expect(within(dialog).getByRole('button', { name: '加上' })).toBeDisabled()
  })

  it('类型清单还在加载：选择与保存都禁用，不显示占位的类型名', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([], {
      // 一直不回来：清单就是「加载中」那一档。
      ListPlatformKinds: () => new Promise(() => {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    const kind = within(dialog).getByRole('combobox', { name: '类型' })
    expect(kind).toBeDisabled()
    expect(within(dialog).getByText('类型清单还在加载')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '加上' })).toBeDisabled()
    // 清单没到的时候不猜一种类型出来，也不写「未选」「未知」这种占位。
    expect(within(dialog).queryByText(/未选|未知/)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument()
  })

  it('填过的地址不被默认地址覆盖：清单到手也不动', async () => {
    const user = userEvent.setup({ delay: null })
    // 清单晚一点才回来：这样才能在清单没到手的时候先把地址填上。
    const kindsGate = deferred<MessageShape<typeof ListPlatformKindsResponseSchema>>()
    const client = clientWith([], {
      ListPlatformKinds: () => kindsGate.promise,
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(await screen.findByRole('button', { name: '新增平台' }))
    const dialog = await screen.findByRole('dialog')

    // 清单还没到就先把地址填上。
    const address = within(dialog).getByLabelText('地址')
    await user.type(address, 'https://mine.example.com/v1')
    expect(address).toHaveValue('https://mine.example.com/v1')

    // 清单到手：只补没填过的那几格，用户填过的地址不许改。
    kindsGate.resolve(
      create(ListPlatformKindsResponseSchema, {
        kinds: [
          create(PlatformKindSchema, {
            kind: 'openai',
            label: 'OpenAI 兼容',
            defaultBaseUrl: 'https://gw.example.com/v1',
            modelsFromUpstream: true,
          }),
        ],
      })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('combobox', { name: '类型' })
      ).toHaveTextContent('OpenAI 兼容')
    )
    expect(address).toHaveValue('https://mine.example.com/v1')
  })

  it('改平台：没有类型选择，只有一行只读的类型名', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientWith([openPlatform({ kind: 'anthropic' })])

    renderWithClient({ client, children: <UpstreamsPage /> })

    const dialog = await openEdit(user, '我的中转站')

    // 名字就用清单里的那一条。
    expect(
      await within(dialog).findByText('类型：Anthropic 兼容')
    ).toBeInTheDocument()
    // 改不了：契约里 UpdatePlatform 没有这一格。
    expect(
      within(dialog).queryByRole('combobox', { name: '类型' })
    ).not.toBeInTheDocument()
  })

  it('平台卡片：类型名按清单里的名字显示', async () => {
    const client = clientWith([openPlatform({ kind: 'anthropic' })])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(await screen.findByText('类型：Anthropic 兼容')).toBeInTheDocument()
  })

  it('清单里没有这一条：摆 raw 值，不说「未知」', async () => {
    const client = clientWith([
      openPlatform({ kind: 'newlang', quotaPlugin: '' }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(await screen.findByText('类型：newlang')).toBeInTheDocument()
    expect(screen.queryByText(/未知/)).not.toBeInTheDocument()
  })

  it('清单还没到手：卡片上不显示类型这一行', async () => {
    const client = clientWith([openPlatform()], {
      ListPlatformKinds: () => new Promise(() => {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    expect(screen.queryByText(/类型：/)).not.toBeInTheDocument()
    // 也不因为清单没到就不显示别的格。
    expect(screen.getByText('https://api.example.com/v1')).toBeInTheDocument()
  })
})

describe('刷新模型目录按钮看平台那一格', () => {
  it('目录不归上游就不摆按钮：厂商模板不再因为清单里没有它而拿不到按钮', async () => {
    // 类型清单是「能新建的那几类」，厂商模板（七牛）与模拟客户端都不在里面。
    // 以前照清单判，七牛这一类平台永远拿不到刷新按钮 —— 现在只看平台自己那一格。
    const client = clientWith([
      openPlatform({
        id: 'qiniu',
        kind: 'qiniu',
        label: '七牛',
        quotaPlugin: '',
        modelsFromUpstream: false,
      }),
      openPlatform({
        id: 'opencode-go',
        kind: 'openai',
        label: '自建中转',
        quotaPlugin: '',
        modelsFromUpstream: true,
      }),
    ])

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('七牛')
    await waitFor(() => {
      expect(
        within(rowOf('自建中转')).getByRole('button', {
          name: '刷新模型目录',
        })
      ).toBeInTheDocument()
    })
    expect(
      within(rowOf('七牛')).queryByRole('button', { name: '刷新模型目录' })
    ).not.toBeInTheDocument()
    // 不解释为什么没有这个按钮。
    expect(screen.queryByText(/不能刷新|不支持刷新/)).not.toBeInTheDocument()
  })

  it('类型清单没到手也不影响这个按钮：它是平台自己那一格说了算', async () => {
    const client = clientWith([openPlatform()], {
      ListPlatformKinds: () => new Promise(() => {}),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    // 以前这一档摆的是禁用按钮加「类型清单还在加载」——清单与这个按钮已无关。
    expect(
      within(rowOf('我的中转站')).getByRole('button', {
        name: '刷新模型目录',
      })
    ).toBeEnabled()
    expect(screen.queryByText(/类型清单还在加载/)).not.toBeInTheDocument()
  })
})

describe('平台模板表', () => {
  it('88 条，id 不重复，都符合 id 的形状', () => {
    expect(PLATFORM_TEMPLATES).toHaveLength(88)

    const ids = PLATFORM_TEMPLATES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const item of PLATFORM_TEMPLATES) {
      // id 是客户端地址里的一段，形状与服务端那套规则一样。
      expect(item.id).toMatch(/^[a-z0-9][a-z0-9-]{0,30}$/)
      expect(item.label).not.toBe('')
      expect(item.baseUrl).toMatch(/^https:\/\//)
    }
  })
})

/**
 * 提交完不能只改本地缓存，要真的再问服务端一次。
 *
 * 这里让假客户端的答复跟着变（加进去了 / 改名了 / 删掉了）：只有提交之后
 * 重新请求过 ListUpstreams，界面才会变成新样子。少了那一步，断言里看到的
 * 就还是提交前那一份 —— 也就是「改完看不见，得手动刷页面」。
 */
describe('改完平台，列表当场重取', () => {
  it('加平台成功：重取列表，新的那一行出现', async () => {
    const user = userEvent.setup({ delay: null })
    const rows: Upstream[] = []
    let listCalls = 0
    const client = clientWith([], {
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [...rows] })
      },
      AddPlatform: (input) => {
        rows.push(
          openPlatform({
            id: input.id ?? '',
            label: input.label ?? '',
            baseUrl: input.baseUrl ?? '',
          })
        )
        return create(AddPlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '新增平台' })
    )
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('平台 id'), 'my-gateway')
    await user.type(within(dialog).getByLabelText('名字'), '我的中转站')
    await user.type(
      within(dialog).getByLabelText('地址'),
      'https://api.example.com/v1'
    )
    await user.click(within(dialog).getByRole('button', { name: '加上' }))

    // 第一次是进页面时取的，第二次是提交完之后重新取的。
    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
    expect(await screen.findByText('我的中转站')).toBeInTheDocument()
  })

  it('改平台成功：重取列表，那一行换成新名字', async () => {
    const user = userEvent.setup({ delay: null })
    const rows: Upstream[] = [openPlatform()]
    let listCalls = 0
    const client = clientWith(rows, {
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [...rows] })
      },
      UpdatePlatform: (input) => {
        rows[0] = openPlatform({ label: input.label ?? '' })
        return create(UpdatePlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    await user.click(
      within(rowOf('我的中转站')).getByRole('button', { name: '编辑' })
    )
    const dialog = await screen.findByRole('dialog')
    await user.clear(within(dialog).getByLabelText('名字'))
    await user.type(within(dialog).getByLabelText('名字'), '新的名字')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
    expect(await screen.findByText('新的名字')).toBeInTheDocument()
    expect(screen.queryByText('我的中转站')).not.toBeInTheDocument()
  })

  it('删平台成功：重取列表，那一行消失', async () => {
    const user = userEvent.setup({ delay: null })
    const rows: Upstream[] = [openPlatform()]
    let listCalls = 0
    const client = clientWith(rows, {
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [...rows] })
      },
      DeletePlatform: () => {
        rows.length = 0
        return create(DeletePlatformResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('我的中转站')
    const del = within(rowOf('我的中转站')).getByRole('button', { name: '删除' })
    await waitFor(() => expect(del).toBeEnabled())
    await user.click(del)
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
    await waitFor(() => {
      expect(screen.queryByText('我的中转站')).not.toBeInTheDocument()
    })
  })
})
