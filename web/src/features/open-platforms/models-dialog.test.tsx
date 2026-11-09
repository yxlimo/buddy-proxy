import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  DeleteModelOverrideRequestSchema,
  DeleteModelOverrideResponseSchema,
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
  UpdatePlatformResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type {
  CatalogModel,
  ModelOverride,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { AdminClient } from '@/features/auth/client-provider'
import {
  PlatformModelsButton,
  PlatformModelsDialog,
} from '@/features/open-platforms/models-dialog'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 保存那一单发出去的样子。 */
type SaveInput = MessageInitShape<typeof SetModelOverridesRequestSchema>
/** 删除那一单发出去的样子。 */
type DeleteInput = MessageInitShape<typeof DeleteModelOverrideRequestSchema>

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

/** 一个假客户端：目录与人工那份按参数给，发出去的请求记在下面那几个数组里。 */
function client({
  models = catalog(),
  overrides = [],
  sent = [],
  deleted = [],
  save,
  listOverrides,
  deleteAnswer,
}: {
  models?: CatalogModel[]
  overrides?: ModelOverride[]
  sent?: SaveInput[]
  deleted?: DeleteInput[]
  /** 让保存那一次失败（这一族方法失败就是一次 Connect 错误）。 */
  save?: () => void
  /** 让删除那一次失败。 */
  deleteAnswer?: () => void
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
      save?.()
      return create(SetModelOverridesResponseSchema)
    },
    DeleteModelOverride: (input) => {
      deleted.push(input)
      deleteAnswer?.()
      return create(DeleteModelOverrideResponseSchema)
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

function setup() {
  return userEvent.setup({ delay: null })
}

/** 目录与人工那两份都到手：上面那个下拉出来了。 */
async function ready(): Promise<HTMLElement> {
  return await screen.findByRole('combobox', { name: '模型 id' })
}

/** 上面那个下拉（它显示的就是当前选中的那条）。 */
function picker(): HTMLElement {
  return screen.getByRole('combobox', { name: '模型 id' })
}

/** 手填那一格：点了「新增模型」之后才换成它。 */
function manualBox(): HTMLInputElement {
  return screen.getByLabelText('模型 id') as HTMLInputElement
}

/** 某一格。选中那一条的几格是同一份，标签就是它们的名字。 */
function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** 那几格里的下拉框。 */
function selectOf(name: string): HTMLElement {
  return screen.getByRole('combobox', { name })
}

/** 打开上面那个下拉，拿到的就是它里面的每一项。 */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(picker())
  return await screen.findAllByRole('option')
}

/**
 * 下拉里列着的候选：这个平台现有的全部模型 id（目录里的与人加的都在）。
 *
 * 顺序就是列表的顺序：第一条就是打开时选中的那条。每一项的 `aria-label` 就是
 * 它的模型 id（「已改」那类标记不算进这个名字里）。
 */
async function candidates(
  user: ReturnType<typeof userEvent.setup>
): Promise<string[]> {
  const options = await openPicker(user)
  const ids = options.map((option) => option.getAttribute('aria-label') ?? '')
  await user.keyboard('{Escape}')
  return ids
}

/** 换成另一个模型：打开下拉，点那一条。 */
async function chooseModel(
  user: ReturnType<typeof userEvent.setup>,
  id: string
) {
  await openPicker(user)
  await user.click(await screen.findByRole('option', { name: id }))
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: '保存' })
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

/** 没碰的格：对象里不该出现这个键。 */
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

/** 某个输入框指向的那条错误。 */
function describedError(input: HTMLElement): HTMLElement {
  const id = input.getAttribute('aria-describedby')
  if (!id) throw new Error('这一格没有指着任何一条错误')
  const node = document.getElementById(id)
  if (!node) throw new Error(`找不到 id 为 ${id} 的那条错误`)
  return node
}

describe('自定义模型弹窗', () => {
  it('打开：列出这个平台的全部模型，默认选第一条', async () => {
    const user = setup()
    openDialog(
      client({
        overrides: [
          // 人工加的模型也在候选里：它是这个平台现有的一条。
          create(ModelOverrideSchema, { id: 'glm-5', displayName: 'GLM-5' }),
        ],
      })
    )

    await ready()
    expect(await candidates(user)).toEqual(['glm-4.6', 'glm-4.5-air', 'glm-5'])
    // 总数就摆在下拉旁边：列表整不整一眼能看出来。
    expect(screen.getByText('共 3 个模型')).toBeInTheDocument()
    // 默认选第一条。
    expect(picker()).toHaveTextContent('glm-4.6')
    // 摆出来的是第一条那几格。倍率给了 0 就写 0。
    expect(field('显示名')).toHaveValue('GLM-4.6')
    expect(field('上下文')).toHaveValue('200000')
    expect(field('输出上限')).toHaveValue('128000')
    expect(field('倍率')).toHaveValue('0')
    expect(selectOf('是否推理')).toHaveTextContent('是')
    expect(selectOf('是否工具')).toHaveTextContent('是')
    // 目录里档位那一格是空的：不设置，也就没有档位输入框。
    expect(selectOf('档位模式')).toHaveTextContent('不设置')
    expect(screen.queryByLabelText('可选档位')).toBeNull()
    // 别的模型那几格不摆。
    expect(screen.queryByDisplayValue('GLM-4.5 Air')).toBeNull()
  })

  it('下拉里的条数就是目录与人工条目之和，每个 id 都在', async () => {
    const user = setup()
    // 拉到五条以上：列表被截断、或者只留“常用的几条”，这条就站不住。
    const models = Array.from({ length: 7 }, (_, at) =>
      create(CatalogModelSchema, { id: `glm-${at + 1}` })
    )
    openDialog(
      client({
        models,
        overrides: [
          // 改目录里已有的一条：不另算一条。
          create(ModelOverrideSchema, { id: 'glm-1', displayName: '改过的' }),
          // 目录里没有的：多算一条。
          create(ModelOverrideSchema, { id: '人工-a' }),
        ],
      })
    )

    await ready()
    const ids = await candidates(user)
    expect(ids).toEqual([
      'glm-1',
      'glm-2',
      'glm-3',
      'glm-4',
      'glm-5',
      'glm-6',
      'glm-7',
      '人工-a',
    ])
    // 总数摆在下拉旁边。
    expect(screen.getByText('共 8 个模型')).toBeInTheDocument()
  })

  it('落过自定义的那几条带「已改」，没改的没有', async () => {
    const user = setup()
    openDialog(
      client({
        overrides: [
          create(ModelOverrideSchema, {
            id: 'glm-4.6',
            displayName: '改过的名字',
          }),
          create(ModelOverrideSchema, { id: 'glm-5', displayName: 'GLM-5' }),
        ],
      })
    )

    await ready()
    const options = await openPicker(user)
    const marks = options.map(
      (option) => within(option).queryByText('已改') !== null
    )
    // glm-4.6 改过、glm-4.5-air 没改、人工那条 glm-5 也是落过的。
    expect(marks).toEqual([true, false, true])
    await user.keyboard('{Escape}')
  })

  it('手填一个已有的 id：就是改那一条，不多出一行', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    await user.click(screen.getByRole('button', { name: '新增模型' }))
    await user.type(manualBox(), 'glm-4.5-air')

    // 填成已有那条：转去选它，手填那一格收起来。
    await waitFor(() => {
      expect(picker()).toHaveTextContent('glm-4.5-air')
    })
    expect(await candidates(user)).toEqual(['glm-4.6', 'glm-4.5-air'])
    expect(screen.getByText('共 2 个模型')).toBeInTheDocument()
    // 摆的也是它原有的那几格，不是空的一份。
    expect(field('显示名')).toHaveValue('GLM-4.5 Air')

    // 改一个字段：发出去的还是 glm-4.5-air 这一条。
    await user.type(field('显示名'), ' 改')
    await user.click(saveButton())
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0]).id).toBe('glm-4.5-air')
  })

  it('改目录里原有的一条：只发一条 SetModelOverrides，不碰平台的模型清单', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    const updatePlatform = vi.fn(() => create(UpdatePlatformResponseSchema))
    openDialog(
      mockAdminClient({
        ListModels: () =>
          create(ListModelsResponseSchema, { models: catalog() }),
        ListModelOverrides: () =>
          create(ListModelOverridesResponseSchema, { overrides: [] }),
        SetModelOverrides: (input) => {
          sent.push(input)
          return create(SetModelOverridesResponseSchema)
        },
        UpdatePlatform: updatePlatform,
      })
    )

    await ready()
    await chooseModel(user, 'glm-4.5-air')
    const name = field('显示名')
    await user.clear(name)
    await user.type(name, '改过的名字')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.5-air',
      displayName: '改过的名字',
    })
    // 改的是目录里原有的模型：只落一条人工条目，平台行的模型清单一个字不动。
    expect(updatePlatform).not.toHaveBeenCalled()
  })

  it('选第二条：只显示它那一套字段', async () => {
    const user = setup()
    openDialog(client({}))

    await ready()
    await chooseModel(user, 'glm-4.5-air')

    expect(picker()).toHaveTextContent('glm-4.5-air')
    expect(field('显示名')).toHaveValue('GLM-4.5 Air')
    expect(field('上下文')).toHaveValue('128000')
    expect(field('输出上限')).toHaveValue('16384')
    // 目录里没给倍率：格子空着，格子里那句说「没报」。
    expect(field('倍率')).toHaveValue('')
    expect(field('倍率').placeholder).toBe('没报')
    expect(selectOf('是否推理')).toHaveTextContent('否')
    expect(selectOf('档位模式')).toHaveTextContent('指定档位')
    expect(field('可选档位')).toHaveValue('low, high')
    // 第一条的那几格已经不在界面上了。
    expect(screen.queryByDisplayValue('200000')).toBeNull()
  })

  it('手填一个新 id：发一条新增，保存后列表里出现它', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    let saved = false
    const admin = mockAdminClient({
      ListModels: () => create(ListModelsResponseSchema, { models: catalog() }),
      ListModelOverrides: () =>
        create(ListModelOverridesResponseSchema, {
          overrides: saved
            ? [create(ModelOverrideSchema, { id: 'glm-9' })]
            : [],
        }),
      SetModelOverrides: (input) => {
        sent.push(input)
        saved = true
        return create(SetModelOverridesResponseSchema)
      },
    })

    renderWithClient({
      client: admin,
      children: <PlatformModelsButton platform={PLATFORM} />,
    })

    await user.click(screen.getByRole('button', { name: '自定义模型' }))
    await ready()
    await user.click(screen.getByRole('button', { name: '新增模型' }))

    expect(manualBox()).toHaveValue('')
    await user.type(manualBox(), 'glm-9')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 只发这一条，只写了 id：元数据沿用原来的来源。
    expect(sent[0].overrides).toHaveLength(1)
    expect(sentOverride(sent[0])).toEqual({ id: 'glm-9' })

    // 存完弹窗关掉；再打开时它就落在下拉里了。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: '自定义模型' }))
    await ready()
    expect(await candidates(user)).toEqual(['glm-4.6', 'glm-4.5-air', 'glm-9'])
  })

  it('没改动：保存禁用、说一句「没有改动」，一个请求都不发', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText('没有改动')).toBeInTheDocument()

    // 点也发不出去。
    await user.click(saveButton())
    expect(sent).toHaveLength(0)

    // 换一条再换回来：还是没改动。
    await chooseModel(user, 'glm-4.5-air')
    await chooseModel(user, 'glm-4.6')
    expect(saveButton()).toBeDisabled()
    expect(sent).toHaveLength(0)
  })

  it('改一个字段：发出去的只有这一条，且只带这一个字段', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    const name = field('显示名')
    await user.clear(name)
    await user.type(name, '改过的名字')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0].overrides).toHaveLength(1)
    // 逐字段对：只有显示名这一格，别的格一个都没写进去。
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.6',
      displayName: '改过的名字',
    })
    for (const key of UNTOUCHED_FIELDS) {
      expect(sentOverride(sent[0])).not.toHaveProperty(key)
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

    await ready()
    expect(field('上下文')).toHaveValue('123456')
    expect(field('倍率')).toHaveValue('0')

    const name = field('显示名')
    await user.clear(name)
    await user.type(name, '改过的名字')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 存的这一条是换掉它那一整行：这一轮没碰的人工格要重新带上。
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-4.6',
      displayName: '改过的名字',
      contextWindow: 123456,
      credits: 0,
    })
  })

  it('人工加的模型改一个字段：它自己与原来写的字段都还在', async () => {
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

    await ready()
    await chooseModel(user, 'glm-5')
    expect(field('显示名')).toHaveValue('GLM-5')
    await user.type(field('输出上限'), '8000')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0])).toEqual({
      id: 'glm-5',
      displayName: 'GLM-5',
      contextWindow: 64000,
      maxOutputTokens: 8000,
      credits: 0,
    })
  })

  it('新增模型：只填 id 的一条，元数据一格都不写', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    await user.click(screen.getByRole('button', { name: '新增模型' }))

    // 新增的这一条字段是空的：只填 id 就是把模型加进目录。
    expect(manualBox()).toHaveValue('')
    expect(field('显示名')).toHaveValue('')
    expect(field('上下文')).toHaveValue('')

    await user.type(manualBox(), 'glm-5')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0])).toEqual({ id: 'glm-5' })
  })

  it('删除：对当前这条发 DeleteModelOverride', async () => {
    const user = setup()
    const deleted: DeleteInput[] = []
    openDialog(
      client({
        deleted,
        overrides: [
          // 人工加进来的模型：库里有它一条人工条目。
          create(ModelOverrideSchema, { id: 'glm-5', displayName: 'GLM-5' }),
        ],
      })
    )

    await ready()
    await chooseModel(user, 'glm-5')
    await user.click(screen.getByRole('button', { name: '删除 glm-5' }))

    await waitFor(() => {
      expect(deleted).toHaveLength(1)
    })
    expect(deleted[0]).toMatchObject({
      platformId: 'workbuddy-cn',
      modelId: 'glm-5',
    })
    // 删完这条不在候选里了；选中落到前一条。
    await waitFor(() => {
      expect(picker()).toHaveTextContent('glm-4.5-air')
    })
    expect(await candidates(user)).toEqual(['glm-4.6', 'glm-4.5-air'])
  })

  it('删除目录里那条改过的：删完回到目录那份值', async () => {
    const user = setup()
    const deleted: DeleteInput[] = []
    openDialog(
      client({
        deleted,
        overrides: [
          create(ModelOverrideSchema, {
            id: 'glm-4.6',
            displayName: '改过的名字',
          }),
        ],
      })
    )

    await ready()
    expect(field('显示名')).toHaveValue('改过的名字')

    await user.click(screen.getByRole('button', { name: '删除 glm-4.6' }))

    await waitFor(() => {
      expect(deleted).toHaveLength(1)
    })
    expect(deleted[0]).toMatchObject({
      platformId: 'workbuddy-cn',
      modelId: 'glm-4.6',
    })
    // 目录里还有这一条：人工那部分没了，摆的是目录那份值。
    await waitFor(() => {
      expect(field('显示名')).toHaveValue('GLM-4.6')
    })
    expect(await candidates(user)).toContain('glm-4.6')
    // 跟基准一样了：没有改动可存。
    expect(saveButton()).toBeDisabled()
  })

  it('档位里多打的逗号不算一档', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    await chooseModel(user, 'glm-4.5-air')
    expect(selectOf('档位模式')).toHaveTextContent('指定档位')
    const tiers = field('可选档位')
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
    openDialog(client({ sent }))

    await ready()
    // 初值是「不设置」：这一格没写。
    expect(selectOf('档位模式')).toHaveTextContent('不设置')

    await user.click(selectOf('档位模式'))
    await user.click(await screen.findByRole('option', { name: '不能选档' }))
    expect(screen.queryByLabelText('可选档位')).toBeNull()

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
    openDialog(client({ sent }))

    await ready()
    await chooseModel(user, 'glm-4.5-air')
    // 目录里有几档：初值就是那几档。改成「不设置」= 回到原来的那份。
    expect(selectOf('档位模式')).toHaveTextContent('指定档位')
    await user.click(selectOf('档位模式'))
    await user.click(await screen.findByRole('option', { name: '不设置' }))

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0]).id).toBe('glm-4.5-air')
    expect(sentOverride(sent[0])).not.toHaveProperty('effortOptions')
    expect(sentEffort(sent[0])).toBeUndefined()
  })

  it('读回「写了、一档都没有」的人工条目：那一格是「不能选档」', async () => {
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

    await ready()
    await chooseModel(user, 'glm-4.5-air')
    // 读回来不能显示成「不设置」，也不能冒出个空输入框。
    expect(selectOf('档位模式')).toHaveTextContent('不能选档')
    expect(screen.queryByLabelText('可选档位')).toBeNull()

    // 这一格没碰：原样带回去，不然改个名字就把它淡成「不设置」了。
    await user.type(field('显示名'), ' 改')
    await user.click(saveButton())
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0])).toHaveProperty('effortOptions')
    expect(sentEffort(sent[0])).toEqual([])
  })

  it('档位选「指定档位」却一档都没填：保存禁用，那一格报错', async () => {
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

    await ready()
    expect(selectOf('档位模式')).toHaveTextContent('指定档位')
    const tiers = field('可选档位')
    await user.clear(tiers)

    const message = await screen.findByText(
      'glm-4.6 · 选了指定档位，就至少填一档'
    )
    expect(saveButton()).toBeDisabled()
    expect(describedError(tiers)).toBe(message)
  })

  it('倍率留空：那一条里没有 credits 字段', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    openDialog(client({ sent }))

    await ready()
    // 目录里没报倍率的那一条：格子空着，改的是别的格。
    await chooseModel(user, 'glm-4.5-air')
    expect(field('倍率')).toHaveValue('')
    const context = field('上下文')
    await user.clear(context)
    await user.type(context, '1000')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
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
    openDialog(client({ sent }))

    await ready()
    await chooseModel(user, 'glm-4.5-air')
    await user.type(field('倍率'), '0')

    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sentOverride(sent[0]).credits).toBe(0)
  })

  it('校验：新加的一条没填 id 就拦下，并指到那一格', async () => {
    const user = setup()
    openDialog(client({}))

    await ready()
    await user.click(screen.getByRole('button', { name: '新增模型' }))

    const message = await screen.findByText('新模型 3 · 模型 id 不能空')
    expect(saveButton()).toBeDisabled()

    const box = manualBox()
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(describedError(box)).toBe(message)
  })

  it('校验：上下文与输出上限只收非负整数，超了 int32 也先拦下', async () => {
    const user = setup()
    openDialog(client({}))

    await ready()
    const context = field('上下文')

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

    // 输出上限那几格同样判。
    const output = field('输出上限')
    await user.clear(output)
    await user.type(output, '-5')
    expect(
      await screen.findByText('glm-4.6 · 输出上限：不能是负数')
    ).toBeInTheDocument()
  })

  it('校验：id 跟另一条只差大小写也算重复，保存禁用', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    // 库里已经有一条只差大小写的：路由匹配模型 id 不分大小写，两条说的是同一个
    // 模型，存下去互相打架 —— 服务端拒（MODEL_ID_DUPLICATE），面板先拦。
    openDialog(
      client({
        sent,
        overrides: [create(ModelOverrideSchema, { id: 'GLM-4.6' })],
      })
    )

    await ready()
    const message = await screen.findByText(
      'glm-4.6 · 模型 id 和另一条只差大小写'
    )
    expect(picker()).toHaveAttribute('aria-invalid', 'true')
    expect(describedError(picker())).toBe(message)
    const button = saveButton()
    expect(button).toBeDisabled()

    // 改别的格也放不行：这一条照样存不下去。点下去不发请求。
    await user.type(field('显示名'), ' 改')
    expect(saveButton()).toBeDisabled()
    await user.click(saveButton())
    expect(sent).toEqual([])
  })

  it('校验：倍率不能是负数', async () => {
    const user = setup()
    openDialog(client({}))

    await ready()
    const credits = field('倍率')
    await user.clear(credits)
    await user.type(credits, '-0.5')

    expect(
      await screen.findByText('glm-4.6 · 倍率：不能是负数')
    ).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
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

    // 重试成功：那一条摆出来了。
    await ready()
    expect(picker()).toHaveTextContent('glm-4.6')
  })

  it('保存失败：弹窗不关，服务端那句话原样显示', async () => {
    const user = setup()
    const closed: boolean[] = []
    openDialog(
      client({
        // 这一族方法的失败是一次 Connect 错误，没有 ok / message 两格。
        save: () => {
          throw new ConnectError(
            '模型 glm-4.6 的上下文不合法：要填正整数',
            Code.InvalidArgument
          )
        },
      }),
      (open) => closed.push(open)
    )

    await ready()
    await user.type(field('显示名'), ' 改')
    await user.click(saveButton())

    expect(
      await screen.findByText(/参数不合法：模型 glm-4.6 的上下文不合法/)
    ).toBeInTheDocument()
    // 弹窗没被关掉：还得改。
    expect(closed).not.toContain(false)
  })

  it('保存成功：弹窗关掉', async () => {
    const user = setup()
    const sent: SaveInput[] = []
    const closed: boolean[] = []
    openDialog(
      client({ sent }),
      (open) => closed.push(open)
    )

    await ready()
    await user.type(field('显示名'), ' 改')
    await user.click(saveButton())

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    // 存上了就把弹窗关掉，不用人再点一次取消。
    await waitFor(() => {
      expect(closed).toEqual([false])
    })
  })

  it('删除失败：服务端说没有这条，弹窗里原样显示', async () => {
    const user = setup()
    openDialog(
      client({
        overrides: [create(ModelOverrideSchema, { id: 'glm-5' })],
        deleteAnswer: () => {
          throw new ConnectError(
            '这个平台没有这条人工元数据：glm-5',
            Code.NotFound
          )
        },
      })
    )

    await ready()
    await chooseModel(user, 'glm-5')
    await user.click(screen.getByRole('button', { name: '删除 glm-5' }))

    expect(
      await screen.findByText(/资源不存在：这个平台没有这条人工元数据/)
    ).toBeInTheDocument()
    // 没删成：这条还在。
    expect(await candidates(user)).toContain('glm-5')
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
    const box = await within(dialog).findByRole('combobox', { name: '模型 id' })
    expect(box).toHaveTextContent('glm-global')
    expect(askedModels).toEqual(['workbuddy-global'])
    expect(askedOverrides).toEqual(['workbuddy-global'])
  })
})
