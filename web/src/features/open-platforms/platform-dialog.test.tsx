import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PlatformKindSchema,
  QuotaPluginSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PlatformDialog } from '@/features/open-platforms/platform-dialog'
import {
  platformKindValue,
  type PlatformKindList,
} from '@/features/open-platforms/platform-kinds'

/**
 * 弹窗交上去的那一单。
 *
 * 新增与修改是两种单子：契约里 UpdatePlatform 没有 kind 这一格，所以改平台的
 * 那一单本身就不带它 —— 不是「带上但 hook 会挑掉」。这里直接看弹窗交出去的东西，
 * 发到线上的请求看不出来（hook 只挑它认识的字段）。
 */

/** 服务端登记的两种方言。 */
const kinds: PlatformKindList = {
  status: 'ready',
  kinds: [
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
  ],
}

/**
 * 服务端现在给的那一屏：先两族方言，再五条预置的模拟客户端（顺序照服务端）。
 *
 * 两个 Qoder、两个 WorkBuddy 的 kind 都跟同族的另一条重了 —— 这就是为什么面板
 * 拿 presetId 认它们，不是拿 kind。
 */
const allKinds: PlatformKindList = {
  status: 'ready',
  kinds: [
    create(PlatformKindSchema, {
      kind: 'openai',
      label: 'OpenAI 兼容',
      category: 'dialect',
      modelsFromUpstream: true,
    }),
    create(PlatformKindSchema, {
      kind: 'anthropic',
      label: 'Anthropic 兼容',
      category: 'dialect',
      modelsFromUpstream: true,
    }),
    create(PlatformKindSchema, {
      kind: 'minimax',
      label: 'MiniMax Code',
      category: 'simulated',
      presetId: 'minimax',
      region: 'cn',
    }),
    create(PlatformKindSchema, {
      kind: 'qoder',
      label: 'Qoder（全球区）',
      category: 'simulated',
      presetId: 'qoder',
      region: 'global',
    }),
    create(PlatformKindSchema, {
      kind: 'qoder',
      label: 'Qoder（中国区）',
      category: 'simulated',
      presetId: 'qoder-cn',
      region: 'cn',
    }),
    create(PlatformKindSchema, {
      kind: 'workbuddy',
      label: 'WorkBuddy（中国区）',
      category: 'simulated',
      presetId: 'workbuddy-cn',
      region: 'cn',
    }),
    create(PlatformKindSchema, {
      kind: 'workbuddy',
      label: 'WorkBuddy（国际区）',
      category: 'simulated',
      presetId: 'workbuddy-global',
      region: 'global',
    }),
  ],
}

/** 表里的一个预置的模拟客户端：地址与额度插件都是空串。 */
const simulatedPlatform = create(UpstreamSchema, {
  id: 'minimax',
  kind: 'minimax',
  label: 'MiniMax Code',
  baseUrl: '',
  quotaPlugin: '',
  modelsAuto: false,
  models: ['MiniMax-M2'],
  isOpenPlatform: true,
  accounts: [],
})

/** 在新增弹窗里挑一条类型。 */
async function pickKind(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: '类型' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

/** 登记表里的一个额度插件。 */
const plugins = [
  create(QuotaPluginSchema, { id: 'qiniu', label: '七牛云资源包', fields: [] }),
]

/**
 * 下拉里每一条的身份两两不同。
 *
 * 下拉的 option 的 value 就是 `platformKindValue`：服务端给出两条同值的，
 * 下拉里就有两个同 value 的 option，选中永远命中第一条（后面那条选不上）。
 * 所以拿 Set 比长度，不是逐条看「现在这批长什么样」。
 */
function expectDistinctValues(list: PlatformKindList) {
  expect(list.status).toBe('ready')
  if (list.status !== 'ready') return
  const values = list.kinds.map(platformKindValue)
  expect(new Set(values).size).toBe(values.length)
}

/** 表里的一个开放平台。 */
const platform = create(UpstreamSchema, {
  id: 'my-gateway',
  kind: 'openai',
  label: '我的中转站',
  baseUrl: 'https://api.example.com/v1',
  quotaPlugin: 'qiniu-portal',
  modelsAuto: true,
  models: ['gpt-4o', 'claude-3'],
  isOpenPlatform: true,
  accounts: [],
})

describe('平台弹窗交出去的那一单', () => {
  it('改平台：没有 kind 这一格', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        platform={platform}
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted).toHaveLength(1)
    // 逐字段对：整单就这几格。
    expect(submitted[0]).toEqual({
      id: 'my-gateway',
      label: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      quotaPlugin: 'qiniu-portal',
      // 开着自动拉：目录不动。
      modelsAuto: true,
      models: [],
    })
    // 多一格都不行：类型建完就改不了。
    expect(submitted[0]).not.toHaveProperty('kind')
  })

  it('新增平台：带 kind，别的格不带', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    await user.type(screen.getByLabelText('平台 id'), 'my-gateway')
    await user.type(screen.getByLabelText('名字'), '我的中转站')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-gateway',
        label: '我的中转站',
        // 清单到手后默认选第一条。
        kind: 'openai',
        baseUrl: '',
      },
    ])
  })
})

describe('新增平台：两族类型', () => {
  /** 新增弹窗（清单是两族都在的那一份）。 */
  function renderAdd(submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        kinds={allKinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  it('类型下拉分两组：模拟客户端在前，开放平台在后', async () => {
    const user = userEvent.setup({ delay: null })
    renderAdd()

    await user.click(screen.getByRole('combobox', { name: '类型' }))

    // 组名：两族各一行，模拟客户端那一组在前。
    expect(await screen.findByText('模拟客户端')).toBeInTheDocument()
    expect(screen.getByText('开放平台')).toBeInTheDocument()
    // 组里的条目：五条预置都摆出来（两个 Qoder、两个 WorkBuddy 各算一条）。
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
      'MiniMax Code',
      'Qoder（全球区）',
      'Qoder（中国区）',
      'WorkBuddy（中国区）',
      'WorkBuddy（国际区）',
      'OpenAI 兼容',
      'Anthropic 兼容',
    ])
  })

  it('选到模拟客户端：id 只说不能改，没有地址、额度插件、模板列表', async () => {
    const user = userEvent.setup({ delay: null })
    renderAdd()

    await pickKind(user, 'MiniMax Code')

    // 预置名由选中的那一条给。
    expect(screen.getByRole('combobox', { name: '类型' })).toHaveTextContent(
      'MiniMax Code'
    )
    // id 只摆出来，不是输入框：客户端路径里那一段由预置定。
    expect(screen.queryByLabelText('平台 id')).not.toBeInTheDocument()
    expect(screen.getByText('minimax')).toBeInTheDocument()
    expect(screen.getByText('客户端走的是 /minimax/v1')).toBeInTheDocument()
    // 地址由模拟端定，额度插件不走平台这一行，模板列表只对方言有意义。
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: '模板列表' })
    ).not.toBeInTheDocument()
  })

  it('选到方言：地址、模板列表照旧，id 还是自己填', async () => {
    const user = userEvent.setup({ delay: null })
    renderAdd()

    await pickKind(user, 'OpenAI 兼容')

    const id = screen.getByLabelText('平台 id')
    expect(id).toBeEnabled()
    await user.type(id, 'my-gateway')
    expect(id).toHaveValue('my-gateway')
    expect(screen.getByLabelText('地址')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '模板列表' })).toBeInTheDocument()
  })

  it('交模拟客户端：id 是预置那一个，地址是空的', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, 'MiniMax Code')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'minimax',
        // 名字默认填预置名（能改）。
        label: 'MiniMax Code',
        baseUrl: '',
        kind: 'minimax',
      },
    ])
  })

  it('两个 Qoder 的 kind 相同：交上去的 id 是各自那一个', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, 'Qoder（中国区）')
    await user.click(screen.getByRole('button', { name: '加上' }))

    // 靠 presetId 分：拿 kind 当 id 就成了全球区那个平台。
    expect(submitted).toEqual([
      { id: 'qoder-cn', label: 'Qoder（中国区）', baseUrl: '', kind: 'qoder' },
    ])
  })
})

describe('改一个模拟客户端', () => {
  it('类型说预置名，地址与额度插件两格不摆', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        platform={simulatedPlatform}
        kinds={allKinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    // 两族 kind 会重名：这一行说的是预置名，不是 raw kind。
    expect(screen.getByText('类型：MiniMax Code')).toBeInTheDocument()
    // 两格的值都是空串：摆出来只会让人以为要填。
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()

    // 整单提交：这两格照空串发，不动库里那一行。
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted).toEqual([
      {
        id: 'minimax',
        label: 'MiniMax Code',
        baseUrl: '',
        quotaPlugin: '',
        modelsAuto: false,
        models: ['MiniMax-M2'],
      },
    ])
  })
})

describe('换一条类型：草稿里那几格跟着走', () => {
  /** 新增弹窗（清单是两族都在的那一份）。 */
  function renderAdd(submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        kinds={allKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  it('下拉值两两不同：两条同 presetId 的话，后面那条永远选不上', () => {
    // 服务端现在给的那一屏：五个预置 + 两种方言。
    expectDistinctValues(allKinds)

    // 判别力自检：真的塞一条与 Qoder（中国区）同 presetId 的进去，这条断言得红。
    // 只断言「当前这批」是看不出这件事的 —— 面板拿 presetId 当 option 的 value，
    // 一旦服务端给出重复值，下拉里就有两个同 value 的 option。
    expect(() =>
      expectDistinctValues({
        status: 'ready',
        kinds: [
          ...allKinds.kinds,
          create(PlatformKindSchema, {
            kind: 'qoder',
            label: 'Qoder（中国区）副本',
            category: 'simulated',
            presetId: 'qoder-cn',
            region: 'cn',
          }),
        ],
      })
    ).toThrow()
  })

  it('选预置 A、没改名、切到预置 B：名字是 B 的', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, 'MiniMax Code')
    // 名字自动填成 A 的（用户没动过这一格）。
    expect(screen.getByLabelText('名字')).toHaveValue('MiniMax Code')

    await pickKind(user, 'Qoder（中国区）')

    // 留着上一条的名字，建出来就是一个名字对不上的平台。
    expect(screen.getByLabelText('名字')).toHaveValue('Qoder（中国区）')

    await user.click(screen.getByRole('button', { name: '加上' }))
    expect(submitted).toEqual([
      { id: 'qoder-cn', label: 'Qoder（中国区）', baseUrl: '', kind: 'qoder' },
    ])
  })

  it('选预置 A、手改名字、切到预置 B：名字留着用户输入', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, 'MiniMax Code')
    const label = screen.getByLabelText('名字')
    await user.clear(label)
    await user.type(label, '我的 MiniMax')

    await pickKind(user, 'Qoder（中国区）')

    // 用户敲过的名字是用户的值：换一条类型不许盖掉。
    expect(screen.getByLabelText('名字')).toHaveValue('我的 MiniMax')

    await user.click(screen.getByRole('button', { name: '加上' }))
    expect(submitted).toEqual([
      { id: 'qoder-cn', label: '我的 MiniMax', baseUrl: '', kind: 'qoder' },
    ])
  })

  it('进预置那一族再切回方言：id 是空的，不留上一个的 id', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    // 方言下 id 是自己填的那一格。
    await pickKind(user, 'OpenAI 兼容')
    await user.type(screen.getByLabelText('平台 id'), 'qoder-cn')

    // 进预置那一族：id 那格不摆，草稿里那个 id 跟现在选中的类型没关系。
    await pickKind(user, 'Qoder（中国区）')
    expect(screen.queryByLabelText('平台 id')).not.toBeInTheDocument()

    // 切回方言：留着的 id 会被当成用户填的提交上去。
    await pickKind(user, 'OpenAI 兼容')
    expect(screen.getByLabelText('平台 id')).toHaveValue('')

    await user.click(screen.getByRole('button', { name: '加上' }))
    expect(submitted).toEqual([
      { id: '', label: '', baseUrl: '', kind: 'openai' },
    ])
  })

  it('方言下选了插件、平台其实是模拟客户端：提交体里的额度插件是空串', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    /** 同一个弹窗，清单换一档（模拟「清单晚一步到手」）。 */
    const dialog = (kinds: PlatformKindList) => (
      <PlatformDialog
        open
        platform={simulatedPlatform}
        kinds={kinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    // 清单还没到手：认不出这个平台是预置的模拟客户端，按方言那套摆，
    // 地址与额度插件两格都在。
    const { rerender } = render(dialog({ status: 'pending' }))
    expect(screen.getByLabelText('地址')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: '七牛云资源包' }))
    expect(screen.getByRole('combobox')).toHaveTextContent('七牛云资源包')

    // 清单到手：认出来是模拟客户端，那两格收起（草稿里那个插件 id 还在）。
    rerender(dialog(allKinds))
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))

    // 模拟客户端的额度不走平台这一行：不许把那个不相干的插件 id 发上去。
    expect(submitted).toEqual([
      {
        id: 'minimax',
        label: 'MiniMax Code',
        baseUrl: '',
        quotaPlugin: '',
        modelsAuto: false,
        models: ['MiniMax-M2'],
      },
    ])
  })
})
