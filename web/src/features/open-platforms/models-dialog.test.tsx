import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListModelOverridesResponseSchema,
  ListModelsResponseSchema,
  ListPlatformKindsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  ModelOverrideSchema,
  SetModelOverridesRequestSchema,
  SetModelOverridesResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { CatalogModel, ModelOverride } from '@/gen/buddy/admin/v1/admin_pb'
import type { AdminClient } from '@/features/auth/client-provider'
import { PlatformModelsDialog } from '@/features/open-platforms/models-dialog'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 保存那一单发出去的样子。 */
type SaveInput = MessageInitShape<typeof SetModelOverridesRequestSchema>

/**
 * 一个模板平台。
 *
 * 目录在代码里，人写的元数据一样能覆盖它 —— 这一份不是开放平台专属的。
 */
const PLATFORM = create(UpstreamSchema, {
  id: 'workbuddy-cn',
  kind: 'workbuddy',
  label: 'WorkBuddy 中国区',
  state: UpstreamState.READY,
  accounts: [],
})

/**
 * 目录里的两个模型。
 *
 * 第一条的倍率是 0：给了 0 就是免费，格子该写 0。第二条没给倍率：那是不知道，
 * 格子空着、格子里那句说「没报」。
 */
function catalog(): CatalogModel[] {
  return [
    create(CatalogModelSchema, {
      id: 'glm-4.6',
      displayName: 'GLM-4.6',
      contextWindow: 200000,
      maxOutputTokens: 128000,
      reasoning: true,
      toolCall: true,
      credits: 0,
    }),
    create(CatalogModelSchema, {
      id: 'glm-4.5-air',
      displayName: 'GLM-4.5 Air',
      contextWindow: 128000,
      maxOutputTokens: 16384,
      reasoning: false,
      toolCall: true,
      effortOptions: ['low', 'high'],
    }),
  ]
}

/** 一个假客户端：目录与人工那份按参数给，保存那一单记在 `sent` 里。 */
function client({
  models = catalog(),
  overrides = [],
  sent = [],
  save,
  listOverrides,
}: {
  models?: CatalogModel[]
  overrides?: ModelOverride[]
  sent?: SaveInput[]
  /** 覆盖保存的答复（默认成功）。 */
  save?: () => MessageInitShape<typeof SetModelOverridesResponseSchema>
  /** 覆盖「人工那份」那一次请求（默认给上面那份）。 */
  listOverrides?: () => MessageInitShape<typeof ListModelOverridesResponseSchema>
}): AdminClient {
  return mockAdminClient({
    ListModels: () => create(ListModelsResponseSchema, { models }),
    ListModelOverrides: () =>
      listOverrides
        ? create(ListModelOverridesResponseSchema, listOverrides())
        : create(ListModelOverridesResponseSchema, { overrides }),
    SetModelOverrides: (input) => {
      sent.push(input)
      return create(
        SetModelOverridesResponseSchema,
        save ? save() : { ok: true, message: '存好了' }
      )
    },
  })
}

/** 打开弹窗（直接渲染弹窗本身，卡片上那个入口见最后一条）。 */
function openDialog(
  admin: AdminClient,
  onOpenChange: (open: boolean) => void = () => {}
) {
  return renderWithClient({
    client: admin,
    children: (
      <PlatformModelsDialog
        open
        platform={PLATFORM}
        onOpenChange={onOpenChange}
      />
    ),
  })
}

/** 一行里那个输入框。 */
function inputOf(row: HTMLElement, label: string): HTMLInputElement {
  return within(row).getByLabelText(label) as HTMLInputElement
}

/** 一行里那个下拉框。 */
function selectOf(row: HTMLElement, name: string): HTMLElement {
  return within(row).getByRole('combobox', { name })
}

/** 目录里那一行（人工加的行没有 id，名字是「新模型 3」这种）。 */
async function rowOf(name: string): Promise<HTMLElement> {
  return await screen.findByRole('group', { name })
}

function setup() {
  return userEvent.setup({ delay: null })
}

/** 某个输入框指向的那条错误。 */
function describedError(input: HTMLElement): HTMLElement {
  const id = input.getAttribute('aria-describedby')
  if (!id) throw new Error('这一格没有指着任何一条错误')
  const node = document.getElementById(id)
  if (!node) throw new Error(`找不到 id 为 ${id} 的那条错误`)
  return node
}

/**
 * 发上去的第几条，只看那几格。
 *
 * protobuf 的消息会带一个 `$typeName`，而且没写的格根本不在对象里 —— 所以
 * 「有没有写这一格」就等价于「对象里有没有这个键」，这正是这里要判的。
 */
function sentOverride(
  input: SaveInput,
  index = 0
): Record<string, unknown> {
  const entry = input.overrides?.[index]
  if (!entry) throw new Error(`这一单里没有第 ${index} 条`)
  const copy: Record<string, unknown> = { ...entry }
  delete copy.$typeName
  return copy
}

/** 没改的格：对象里不该出现这个键。 */
const UNTOUCHED_FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'reasoning',
  'toolCall',
  'credits',
] as const

/**
 * 发上去的那一条里「档位」这一格。
 *
 * 没写这一格 → `undefined`（沿用原来的档位）；写了空列表 → `[]`（明确不能选
 * 档）；写了几档 → 那几个。三种说法在线上分得开，这里也就分得开。
 */
function sentEffort(input: SaveInput, index = 0): string[] | undefined {
  const entry = input.overrides?.[index]
  if (!entry) throw new Error(`这一单里没有第 ${index} 条`)
  return entry.effortOptions?.levels
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: '保存' })
}

describe('自定义模型弹窗', () => {
  it('打开：把目录里的模型摆出来，倍率分得清「没报」与「0」', async () => {
    openDialog(client({ overrides: [] }))

    const first = await rowOf('glm-4.6')
    expect(inputOf(first, '显示名')).toHaveValue('GLM-4.6')
    expect(inputOf(first, '上下文')).toHaveValue('200000')
    expect(inputOf(first, '输出上限')).toHaveValue('128000')
    // 目录里写着 0：那是免费，格子就该写 0。
    expect(inputOf(first, '倍率')).toHaveValue('0')
    expect(selectOf(first, '是否推理')).toHaveTextContent('是')
    expect(selectOf(first, '是否工具')).toHaveTextContent('是')
    // 目录里这一格是空的：那是不知道，初值是「不设置」，就没有那个输入框。
    expect(selectOf(first, '档位模式')).toHaveTextContent('不设置')
    expect(within(first).queryByLabelText('可选档位')).toBeNull()
    // 目录里没有「默认档」这一格，弹窗里也不该有。
    expect(within(first).queryByLabelText('默认档')).toBeNull()

    const second = await rowOf('glm-4.5-air')
    expect(inputOf(second, '上下文')).toHaveValue('128000')
    // 目录里没给倍率：格子空着，格子里那句说「没报」。
    expect(inputOf(second, '倍率')).toHaveValue('')
    expect(inputOf(second, '倍率').placeholder).toBe('没报')
    expect(selectOf(second, '是否推理')).toHaveTextContent('否')
    expect(selectOf(second, '档位模式')).toHaveTextContent('指定档位')
    expect(inputOf(second, '可选档位')).toHaveValue('low, high')
  })

  it('只改一个字段：发出去的只有那一条，且只带那一个字段', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    const row = await rowOf('glm-4.6')
    const name = inputOf(row, '显示名')
    await user.clear(name)
    await user.type(name, '改过的名字')

    // 改过的行要看得出来。
    expect(within(row).getByText('已改')).toBeInTheDocument()

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].platformId).toBe('workbuddy-cn')
    expect(sent[0].overrides).toHaveLength(1)
    // 逐字段对：只有显示名这一格，别的格一个都没写进去。
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.6',
      displayName: '改过的名字',
    })
    for (const field of UNTOUCHED_FIELDS) {
      expect(sentOverride(sent[0])).not.toHaveProperty(field)
    }
    // 档位没碰过：这一格根本不出现（跟「不能选档」的空列表不是一回事）。
    expect(sentOverride(sent[0])).not.toHaveProperty('effortOptions')
  })

  it('改一个字段：原来人工写下的别的字段原样带上去', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(
      client({
        sent,
        overrides: [
          // 人工写过两格：一个数字，一个 0（0 是「免费」，不是「没填」）。
          create(ModelOverrideSchema, {
            id: 'glm-4.6',
            contextWindow: 123456,
            credits: 0,
          }),
        ],
      })
    )

    const row = await rowOf('glm-4.6')
    expect(inputOf(row, '上下文')).toHaveValue('123456')
    expect(inputOf(row, '倍率')).toHaveValue('0')

    const name = inputOf(row, '显示名')
    await user.clear(name)
    await user.type(name, '改过的名字')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 保存是整体替换：这一轮没碰的人工格要重新带上，否则改个名字就把它们删了。
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.6',
      displayName: '改过的名字',
      contextWindow: 123456,
      credits: 0,
    })
  })

  it('人工加的模型改一个字段：它自己与原来的自定义字段都还在', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(
      client({
        sent,
        overrides: [
          // 目录里没有 glm-5：整条都是人写的。
          create(ModelOverrideSchema, {
            id: 'glm-5',
            displayName: 'GLM-5',
            contextWindow: 64000,
            credits: 0,
          }),
        ],
      })
    )

    const row = await rowOf('glm-5')
    expect(inputOf(row, '显示名')).toHaveValue('GLM-5')
    await user.type(inputOf(row, '输出上限'), '8000')

    // 改了一格，这一行还在列表里。
    expect(screen.getByRole('group', { name: 'glm-5' })).toBeInTheDocument()

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 人工加的那条不会被当成目录里的一条处理：id 与原来写的格都还在。
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-5',
      displayName: 'GLM-5',
      contextWindow: 64000,
      maxOutputTokens: 8000,
      credits: 0,
    })
  })

  it('加一个模型：它在 overrides 里，带界面上填的字段', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ models: [], overrides: [], sent }))

    await screen.findByText('目录里还没有模型')
    await user.click(screen.getByRole('button', { name: '加模型' }))

    const row = await rowOf('新模型 1')
    await user.type(within(row).getByLabelText('模型 id'), 'glm-5')
    await user.type(inputOf(row, '显示名'), 'GLM-5')
    await user.type(inputOf(row, '上下文'), '64000')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-5',
      displayName: 'GLM-5',
      contextWindow: 64000,
    })
    for (const field of UNTOUCHED_FIELDS.filter(
      (field) => field !== 'contextWindow'
    )) {
      expect(sentOverride(sent[0])).not.toHaveProperty(field)
    }
  })

  it('档位里多打的逗号不算一档', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    const row = await rowOf('glm-4.5-air')
    expect(selectOf(row, '档位模式')).toHaveTextContent('指定档位')
    const tiers = inputOf(row, '可选档位')
    await user.clear(tiers)
    await user.type(tiers, 'low,,high')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 空段与空白不算一档，但这一格是写了的：不能丢成「不设置」。
    expect(sentEffort(sent[0])).toEqual(['low', 'high'])
    expect(sentOverride(sent[0])).toHaveProperty('effortOptions')
  })

  it('档位选「不能选档」：发上去是写了的空列表', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    const row = await rowOf('glm-4.6')
    // 初值是「不设置」：这一格没写。
    expect(selectOf(row, '档位模式')).toHaveTextContent('不设置')

    await user.click(selectOf(row, '档位模式'))
    await user.click(await screen.findByRole('option', { name: '不能选档' }))
    expect(within(row).queryByLabelText('可选档位')).toBeNull()

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 写了、一档都没有：跟「不设置」不是一回事。
    expect(sentOverride(sent[0])).toHaveProperty('effortOptions')
    expect(sentEffort(sent[0])).toEqual([])
  })

  it('档位选「不设置」：发上去干脆不带这一格', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    const row = await rowOf('glm-4.5-air')
    // 目录里有几档：初值就是那几档。改成「不设置」= 回到原来的那份。
    expect(selectOf(row, '档位模式')).toHaveTextContent('指定档位')
    await user.click(selectOf(row, '档位模式'))
    await user.click(await screen.findByRole('option', { name: '不设置' }))

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0]).id).toBe('glm-4.5-air')
    expect(sentOverride(sent[0])).not.toHaveProperty('effortOptions')
    expect(sentEffort(sent[0])).toBeUndefined()
  })

  it('读回「写了、一档都没有」的人工条目：那一行是「不能选档」', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(
      client({
        sent,
        overrides: [
          create(ModelOverrideSchema, {
            id: 'glm-4.5-air',
            effortOptions: { levels: [] },
          }),
        ],
      })
    )

    const row = await rowOf('glm-4.5-air')
    // 读回来不能显示成「不设置」，也不能冒出个空输入框。
    expect(selectOf(row, '档位模式')).toHaveTextContent('不能选档')
    expect(within(row).queryByLabelText('可选档位')).toBeNull()

    // 这一格没碰：原样带回去，不然改个名字就把它淡成「不设置」了。
    await user.type(inputOf(row, '显示名'), ' 改')
    await user.click(saveButton())
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0])).toHaveProperty('effortOptions')
    expect(sentEffort(sent[0])).toEqual([])
  })

  it('档位选「指定档位」却一档都没填：保存禁用，那一行报错', async () => {
    const user = setup()
    openDialog(
      client({
        overrides: [
          // 人工写下的那几档，清空了就是没填。
          create(ModelOverrideSchema, {
            id: 'glm-4.6',
            effortOptions: { levels: ['low'] },
          }),
        ],
      })
    )

    const row = await rowOf('glm-4.6')
    expect(selectOf(row, '档位模式')).toHaveTextContent('指定档位')
    const tiers = inputOf(row, '可选档位')
    await user.clear(tiers)

    const message = await screen.findByText(
      'glm-4.6 · 选了指定档位，就至少填一档'
    )
    expect(saveButton()).toBeDisabled()
    expect(describedError(tiers)).toBe(message)
  })

  it('删掉一个模型：它不在 overrides 里', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(
      client({
        sent,
        overrides: [
          // 人工加进来的模型。
          create(ModelOverrideSchema, { id: 'glm-5', displayName: 'GLM-5' }),
          // 目录里的那条，改过名字。
          create(ModelOverrideSchema, {
            id: 'glm-4.6',
            displayName: '改过的名字',
          }),
        ],
      })
    )

    const added = await rowOf('glm-5')
    const edited = await rowOf('glm-4.6')
    expect(inputOf(edited, '显示名')).toHaveValue('改过的名字')

    // 人工加的那条：整条拿掉。
    await user.click(within(added).getByRole('button', { name: '删掉 glm-5' }))
    expect(screen.queryByRole('group', { name: 'glm-5' })).not.toBeInTheDocument()

    // 目录里那条：回到目录里的值。它还在目录里，所以行还在。
    await user.click(
      within(edited).getByRole('button', { name: '删掉 glm-4.6' })
    )
    expect(inputOf(edited, '显示名')).toHaveValue('GLM-4.6')
    expect(within(edited).queryByText('已改')).not.toBeInTheDocument()

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 两个人工条目都删干净了：发的是空列表。
    expect(sent[0].overrides).toEqual([])
  })

  it('删掉人工加的那一行：列表里不再有它，也不会冒出第二行同名模型', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    await rowOf('glm-4.6')
    await user.click(screen.getByRole('button', { name: '加模型' }))
    const added = await rowOf('新模型 3')
    // 人工加的行把 id 填成目录里已有的那一条。
    await user.type(within(added).getByLabelText('模型 id'), 'glm-4.6')

    // 撞上了：报重复，存不了。
    expect(await screen.findByText('glm-4.6 · 模型 id 重复')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '删掉 glm-4.6' }))

    // 人工加的那行整条没了：目录里那一行还在，只剩一行 glm-4.6，也不再报重复。
    expect(screen.queryByText('glm-4.6 · 模型 id 重复')).not.toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'glm-4.6' })).toHaveLength(1)
    expect(saveButton()).toBeEnabled()

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toEqual([])
  })

  it('什么都没改就保存：发的是空列表', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    await rowOf('glm-4.6')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 目录里那几条不会被写成人工作品。
    expect(sent[0].overrides).toEqual([])
  })

  it('自定义那部分取不到：保存禁用、显示原因，重试能再来一次', async () => {
    const user = setup()
    let attempts = 0
    openDialog(
      client({
        listOverrides: () => {
          attempts += 1
          if (attempts === 1) {
            throw new ConnectError('库里那行读不出来', Code.Internal)
          }
          return { overrides: [] }
        },
      })
    )

    expect(
      await screen.findByText(/自定义那部分取不到：.*库里那行读不出来/)
    ).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '重试' }))

    // 重试成功：目录摆出来了，能保存了。
    await rowOf('glm-4.6')
    expect(saveButton()).toBeEnabled()
  })

  it('保存失败：弹窗不关，服务端那句话原样显示', async () => {
    const user = setup()
    const closed: boolean[] = []
    openDialog(
      client({
        overrides: [],
        save: () => ({
          ok: false,
          message: '模型 glm-4.6 的上下文不合法：要填正整数',
        }),
      }),
      (open) => closed.push(open)
    )

    const row = await rowOf('glm-4.6')
    await user.type(inputOf(row, '显示名'), ' 改')
    await user.click(saveButton())

    expect(
      await screen.findByText('模型 glm-4.6 的上下文不合法：要填正整数')
    ).toBeInTheDocument()
    // 弹窗没被关掉：还得改。
    expect(closed).not.toContain(false)
  })

  it('保存成功：弹窗关掉', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    const closed: boolean[] = []
    openDialog(
      client({ overrides: [], sent }),
      (open) => closed.push(open)
    )

    const row = await rowOf('glm-4.6')
    await user.type(inputOf(row, '显示名'), ' 改')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 存上了就把弹窗关掉，不用人再点一次取消。
    await waitFor(() => {
      expect(closed).toEqual([false])
    })
  })

  it('倍率留空：overrides 里没有 credits 字段', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    // 目录里没报倍率的那一条：格子空着，改的是别的格。
    const row = await rowOf('glm-4.5-air')
    expect(inputOf(row, '倍率')).toHaveValue('')
    const context = inputOf(row, '上下文')
    await user.clear(context)
    await user.type(context, '1000')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.5-air',
      contextWindow: 1000,
    })
    // 倍率没填：credits 这个键压根不出现（跟「免费」的 0 不是一回事）。
    expect(sentOverride(sent[0])).not.toHaveProperty('credits')
  })

  it('倍率填 0：credits 是 0，不是「不知道」', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ overrides: [], sent }))

    const row = await rowOf('glm-4.5-air')
    await user.type(inputOf(row, '倍率'), '0')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0]).credits).toBe(0)
  })

  it('校验：新加的行没填 id 就拦下，并指到那一格', async () => {
    const user = setup()
    openDialog(client({ overrides: [] }))

    await rowOf('glm-4.6')
    await user.click(screen.getByRole('button', { name: '加模型' }))

    const added = await rowOf('新模型 3')
    const message = await screen.findByText('新模型 3 · 模型 id 不能空')
    expect(saveButton()).toBeDisabled()

    const id = within(added).getByLabelText('模型 id')
    expect(id).toHaveAttribute('aria-invalid', 'true')
    expect(describedError(id)).toBe(message)
  })

  it('校验：两行填成同一个 id，那句重复只说一次，两行都指过去', async () => {
    const user = setup()
    openDialog(client({ overrides: [] }))

    await rowOf('glm-4.6')
    await user.click(screen.getByRole('button', { name: '加模型' }))
    await user.click(screen.getByRole('button', { name: '加模型' }))
    const first = await rowOf('新模型 3')
    const second = await rowOf('新模型 4')
    await user.type(within(first).getByLabelText('模型 id'), 'glm-4.6')
    await user.type(within(second).getByLabelText('模型 id'), 'glm-4.6')

    // 同一句话不摆三遍（目录里那条不算错，只有人工加的两行撞上了）。
    const messages = await screen.findAllByText('glm-4.6 · 模型 id 重复')
    expect(messages).toHaveLength(1)

    const firstError = describedError(within(first).getByLabelText('模型 id'))
    const secondError = describedError(within(second).getByLabelText('模型 id'))
    expect(firstError).toBe(messages[0])
    expect(secondError).toBe(messages[0])
    expect(saveButton()).toBeDisabled()
  })

  it('校验：上下文与输出上限只收非负整数，超了 int32 也先拦下', async () => {
    const user = setup()
    openDialog(client({ overrides: [] }))

    const row = await rowOf('glm-4.6')
    const context = inputOf(row, '上下文')

    await user.clear(context)
    await user.type(context, '-1')
    expect(
      await screen.findByText('glm-4.6 · 上下文：不能是负数')
    ).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(context).toHaveAttribute('aria-invalid', 'true')

    await user.clear(context)
    await user.type(context, '1.5')
    expect(
      await screen.findByText('glm-4.6 · 上下文：要填整数')
    ).toBeInTheDocument()

    await user.clear(context)
    await user.type(context, '2147483648')
    expect(
      await screen.findByText('glm-4.6 · 上下文：别超过 2147483647')
    ).toBeInTheDocument()

    await user.clear(context)
    await user.type(context, '2147483647')
    expect(screen.queryByText(/· 上下文：/)).not.toBeInTheDocument()
    expect(context).not.toHaveAttribute('aria-invalid')
    expect(saveButton()).toBeEnabled()

    // 输出上限那两格同样判。
    const output = inputOf(row, '输出上限')
    await user.clear(output)
    await user.type(output, '-5')
    expect(
      await screen.findByText('glm-4.6 · 输出上限：不能是负数')
    ).toBeInTheDocument()
  })

  it('校验：倍率不能是负数', async () => {
    const user = setup()
    openDialog(client({ overrides: [] }))

    const row = await rowOf('glm-4.6')
    const credits = inputOf(row, '倍率')
    await user.clear(credits)
    await user.type(credits, '-0.5')

    expect(
      await screen.findByText('glm-4.6 · 倍率：不能是负数')
    ).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('平台卡片上有入口：点哪一行就取哪一行的目录', async () => {
    const user = setup()
    const askedModels: string[] = []
    const askedOverrides: string[] = []
    const admin = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'workbuddy-cn',
              kind: 'workbuddy',
              label: 'WorkBuddy 中国区',
              state: UpstreamState.READY,
              // 播种出来的平台都有行：人工元数据写在那一行上。
              fromRow: true,
              accounts: [],
            }),
            create(UpstreamSchema, {
              id: 'workbuddy-global',
              kind: 'workbuddy',
              label: 'WorkBuddy 海外',
              state: UpstreamState.READY,
              fromRow: true,
              accounts: [],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      ListQuotaPlugins: () =>
        create(ListQuotaPluginsResponseSchema, { plugins: [] }),
      ListPlatformKinds: () =>
        create(ListPlatformKindsResponseSchema, { kinds: [] }),
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, { models: [] }),
      ListModels: (input) => {
        askedModels.push(input.upstreamId ?? '')
        // 两行的目录不一样：取错了平台这件事就藏不住。
        return create(ListModelsResponseSchema, {
          models:
            input.upstreamId === 'workbuddy-global'
              ? [create(CatalogModelSchema, { id: 'glm-global' })]
              : catalog(),
        })
      },
      ListModelOverrides: (input) => {
        askedOverrides.push(input.platformId ?? '')
        return create(ListModelOverridesResponseSchema, { overrides: [] })
      },
    })

    renderWithClient({ client: admin, children: <UpstreamsPage /> })

    const row = (await screen.findByText('WorkBuddy 海外')).closest('tr')
    if (!row) throw new Error('找不到 WorkBuddy 海外 那一行')
    await user.click(within(row).getByRole('button', { name: '自定义模型' }))

    const dialog = await screen.findByRole('dialog')
    expect(
      await within(dialog).findByRole('group', { name: 'glm-global' })
    ).toBeInTheDocument()
    expect(askedModels).toEqual(['workbuddy-global'])
    expect(askedOverrides).toEqual(['workbuddy-global'])
  })
})
