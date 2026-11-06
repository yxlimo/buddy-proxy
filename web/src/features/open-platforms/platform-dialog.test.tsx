import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  PlatformKindSchema,
  QuotaPluginSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
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

/**
 * 表里的一个预置的模拟客户端。
 *
 * 播种出来的那一行：表里有它（`fromRow`），但服务端不算它作开放平台
 * （`isOpenPlatform` 为假）—— 地址与额度插件归代码，面板不摆也不往上送。
 */
const simulatedPlatform = create(UpstreamSchema, {
  id: 'minimax',
  kind: 'minimax',
  label: 'MiniMax Code',
  baseUrl: '',
  quotaPlugin: '',
  modelsAuto: false,
  models: ['MiniMax-M2'],
  isOpenPlatform: false,
  fromRow: true,
  accounts: [],
})

/**
 * 模拟客户端，但服务端给的形状里没有 `isOpenPlatform` 这一格。
 *
 * 「没说」不能当成「不是模拟客户端」:那样会给模拟客户端露出地址格，用户一
 * 填就写进那一行。真开放平台这一格一定是 true。
 */
function platformWithoutOpenFlag(): Upstream {
  const message = create(UpstreamSchema, {
    id: 'minimax',
    kind: 'minimax',
    label: 'MiniMax Code',
    models: ['MiniMax-M2'],
    fromRow: true,
    accounts: [],
  })
  delete (message as { isOpenPlatform?: boolean }).isOpenPlatform
  return message
}

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
  fromRow: true,
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
        existing={[]}
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
        existing={[]}
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    await user.type(screen.getByLabelText('平台 id'), 'my-gateway')
    await user.type(screen.getByLabelText('名字'), '我的中转站')
    // 地址是必填的一格：空着保存按钮是灰的，请求不发（这是提交前的拦截）。
    await user.type(screen.getByLabelText('地址'), 'https://api.example.com/v1')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-gateway',
        label: '我的中转站',
        // 清单到手后默认选第一条。
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        // 这一类没有默认插件：发空串 = 不用插件。
        quotaPlugin: '',
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
        existing={[]}
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
  /** 改一个模拟客户端的弹窗。 */
  function renderEdit(platformMessage: Upstream, submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        platform={platformMessage}
        existing={[]}
        kinds={allKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  it('类型说预置名，地址与额度插件两格不摆', () => {
    renderEdit(simulatedPlatform)

    // 两族 kind 会重名：这一行说的是预置名，不是 raw kind。
    expect(screen.getByText('类型：MiniMax Code')).toBeInTheDocument()
    // 这两格的值都是空串：摆出来只会让人以为要填。
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()
  })

  it('只改名字：交上去的那一单里没有 baseUrl、也没有 quotaPlugin', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderEdit(simulatedPlatform)

    const label = screen.getByLabelText('名字')
    await user.clear(label)
    await user.type(label, '我的 MiniMax')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted).toHaveLength(1)
    // 判据是「整格不出现」：带一个空串就是「清空那一格」，库里原来那份就没了。
    expect(submitted[0]).not.toHaveProperty('baseUrl')
    expect(submitted[0]).not.toHaveProperty('quotaPlugin')
    expect(submitted[0]).toEqual({
      id: 'minimax',
      label: '我的 MiniMax',
      modelsAuto: false,
      models: ['MiniMax-M2'],
    })
  })

  it('名字是这一行的值：不动名字格直接保存，交上去的不是预置名', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    // 名字跟预置名不一样（用户以前改过）：那是用户的值。
    const renamed = create(UpstreamSchema, {
      id: 'minimax',
      kind: 'minimax',
      label: '我的 MiniMax',
      models: ['MiniMax-M2'],
      isOpenPlatform: false,
      fromRow: false,
      accounts: [],
    })

    const dialog = (list: PlatformKindList) => (
      <PlatformDialog
        open
        platform={renamed}
        existing={[]}
        kinds={list}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    // 清单还没到手：认不出是哪一条预置，只看这一行自己说不说得清（族的问题，
    // 与「表里有没有这一行」无关）。地址与额度插件那两格从一开始就不摆。
    const { rerender } = render(dialog({ status: 'pending' }))
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()

    // 清单到手：类型那一行说得出来了，名字不许被目录里的预置名盖掉。
    rerender(dialog(allKinds))
    expect(screen.getByText('类型：MiniMax Code')).toBeInTheDocument()
    expect(screen.getByLabelText('名字')).toHaveValue('我的 MiniMax')

    await user.click(screen.getByRole('button', { name: '保存' }))

    // 整单对：多一格都不行（baseUrl / quotaPlugin 在模拟客户端这一族不出现）。
    expect(submitted).toEqual([
      {
        id: 'minimax',
        label: '我的 MiniMax',
        modelsAuto: false,
        models: ['MiniMax-M2'],
      },
    ])
  })

  it('行上原有的 quota_plugin 不会被前端抹掉：仍是不带这一格', async () => {
    const user = userEvent.setup({ delay: null })
    // 库里那一行上存着一个插件 id（面板不掌这一格，但也不能把它冲成空串）。
    const submitted = renderEdit(
      create(UpstreamSchema, {
        id: 'minimax',
        kind: 'minimax',
        label: 'MiniMax Code',
        quotaPlugin: 'qiniu',
        models: ['MiniMax-M2'],
        isOpenPlatform: false,
        fromRow: true,
        accounts: [],
      })
    )

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted[0]).not.toHaveProperty('quotaPlugin')
    expect(submitted[0]).not.toHaveProperty('baseUrl')
  })

  it('开放平台改名字：地址与额度插件两格带上现在的值', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        platform={platform}
        existing={[]}
        kinds={allKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    const label = screen.getByLabelText('名字')
    await user.clear(label)
    await user.type(label, '新的名字')
    await user.click(screen.getByRole('button', { name: '保存' }))

    // 开放平台那两格本来就摆在界面上：整单提交带的是现在的值。
    expect(submitted[0]).toEqual({
      id: 'my-gateway',
      label: '新的名字',
      baseUrl: 'https://api.example.com/v1',
      quotaPlugin: 'qiniu-portal',
      modelsAuto: true,
      models: [],
    })
  })
})

describe('改平台时怎么判是不是模拟客户端', () => {
  /** 清单取不到那一档：认不出预置，只看平台那一行自己说不说得清。 */
  const noKinds: PlatformKindList = {
    status: 'error',
    message: '类型清单取不到',
  }

  function renderEdit(platformMessage: Upstream) {
    const submitted: unknown[] = []
    render(
      <PlatformDialog
        open
        platform={platformMessage}
        existing={[]}
        kinds={noKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  it('清单取不到：服务端说是开放平台的那一个，地址照样摆出来', () => {
    renderEdit(platform)

    // 控制组：开放平台的地址格不能被误判成模拟客户端藏起来。
    expect(screen.getByLabelText('地址')).toHaveValue(
      'https://api.example.com/v1'
    )
    expect(screen.getByLabelText('额度插件')).toBeInTheDocument()
  })

  it('清单取不到：模拟客户端（isOpenPlatform 为假）不摆地址', () => {
    renderEdit(simulatedPlatform)

    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()
  })

  it('清单取不到：这一格缺失也不摆地址（「没说」不是「不是」）', () => {
    renderEdit(platformWithoutOpenFlag())

    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()
  })

  it('模拟客户端：目录归代码，不摆「自动拉」开关，也不摆可改的目录', () => {
    renderEdit(simulatedPlatform)

    // 服务端对模拟客户端的 models / modelsAuto 一律忽略：摆出来的开关与文本域
    // 就成了两个改了也不算数的控件。
    expect(
      screen.queryByRole('switch', { name: '自动拉模型目录' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('模型目录')).not.toBeInTheDocument()
    // 说清这一格为什么没有。
    expect(
      screen.getByText('模型目录由代码提供，不能改。')
    ).toBeInTheDocument()
  })

  it('开放平台：开关与目录都还在（控制组）', () => {
    renderEdit(platform)

    expect(
      screen.getByRole('switch', { name: '自动拉模型目录' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('模型目录')).toBeInTheDocument()
    expect(
      screen.queryByText('模型目录由代码提供，不能改。')
    ).not.toBeInTheDocument()
  })
})

describe('换一条类型：草稿里那几格跟着走', () => {
  /** 新增弹窗（清单是两族都在的那一份）。 */
  function renderAdd(submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        existing={[]}
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

    // id 空着就不发请求：空 id 那个错在按保存前就拦下了。
    expect(screen.getByRole('button', { name: '加上' })).toBeDisabled()
    expect(submitted).toEqual([])

    await user.type(screen.getByLabelText('平台 id'), 'qoder-cn')
    await user.type(screen.getByLabelText('名字'), '自己搭的')
    await user.type(screen.getByLabelText('地址'), 'https://qoder.example.com/v1')
    await user.click(screen.getByRole('button', { name: '加上' }))
    expect(submitted).toEqual([
      {
        id: 'qoder-cn',
        label: '自己搭的',
        baseUrl: 'https://qoder.example.com/v1',
        kind: 'openai',
        // 这一类没有默认插件：发空串 = 不用插件。
        quotaPlugin: '',
      },
    ])
  })

  it('清单晚一步到手：模拟客户端那两格从头就不摆，提交体也不带', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    /** 同一个弹窗，清单换一档（模拟「清单晚一步到手」）。 */
    const dialog = (kinds: PlatformKindList) => (
      <PlatformDialog
        open
        platform={simulatedPlatform}
        existing={[]}
        kinds={kinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    // 清单还没到手：认不出是哪一条预置，但平台那一行自己说得清楚（表里有行、
    // 不是开放平台）。不靠清单说话，模拟客户端的两格从头就不摆。
    const { rerender } = render(dialog({ status: 'pending' }))
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()

    // 清单到手：还是那样，两格不会忽然冒出来。
    rerender(dialog(allKinds))
    expect(screen.queryByLabelText('地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('额度插件')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted[0]).not.toHaveProperty('baseUrl')
    expect(submitted[0]).not.toHaveProperty('quotaPlugin')
  })
})

describe('正常操作点不出的错：提交前就拦住', () => {
  /** 表里现有的两个平台：一个开放平台，一个名下有账号的预置。 */
  const existing: Upstream[] = [
    platform,
    create(UpstreamSchema, {
      id: 'qoder',
      kind: 'qoder',
      label: 'Qoder',
      isOpenPlatform: false,
      fromRow: true,
      accounts: [
        create(AccountSchema, { id: 'qoder-2', platform: 'qoder' }),
      ],
    }),
  ]

  /** 新增弹窗，表里现有的平台照上面那一份。 */
  function renderAdd(submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        existing={existing}
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  /** 把三格填成能过的那一份。 */
  async function fillValid(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('平台 id'), 'my-other')
    await user.type(screen.getByLabelText('名字'), '另一个中转站')
    await user.type(
      screen.getByLabelText('地址'),
      'https://api.example.com/v1'
    )
  }

  it('id 已经被别的平台占了：保存灰着、行内说清，一个请求都不发', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await user.type(screen.getByLabelText('平台 id'), 'my-gateway')
    await user.type(screen.getByLabelText('名字'), '同名')
    await user.type(
      screen.getByLabelText('地址'),
      'https://api.example.com/v1'
    )

    const id = screen.getByLabelText('平台 id')
    expect(
      screen.getByText('这个平台 id 已经被占用')
    ).toBeInTheDocument()
    // 那一格自己指着这句话：红边框之外还说得出来。
    expect(id).toHaveAttribute('aria-invalid', 'true')
    const button = screen.getByRole('button', { name: '加上' })
    expect(button).toBeDisabled()

    // 判别力所在：点下去也不会有东西交出去。
    await user.click(button)
    expect(submitted).toEqual([])

    // 换一个没被占用的 id：提示没了，按钮回来。
    await user.clear(id)
    await user.type(id, 'my-other')
    expect(
      screen.queryByText('这个平台 id 已经被占用')
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加上' })).toBeEnabled()
  })

  it('id 格式不对：保存灰着、行内说清，一个请求都不发', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await user.type(screen.getByLabelText('平台 id'), 'My_Gateway')
    await user.type(screen.getByLabelText('名字'), '大写那个')
    await user.type(
      screen.getByLabelText('地址'),
      'https://api.example.com/v1'
    )

    expect(
      screen.getByText('平台 id 只能用小写字母、数字和连字符')
    ).toBeInTheDocument()
    const button = screen.getByRole('button', { name: '加上' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(submitted).toEqual([])
  })

  it('地址不是完整的网址：保存灰着、行内说清', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await user.type(screen.getByLabelText('平台 id'), 'my-other')
    await user.type(screen.getByLabelText('名字'), '少了协议')
    await user.type(screen.getByLabelText('地址'), 'api.example.com/v1')

    expect(
      screen.getByText('地址不是以 http:// 或 https:// 开头的完整网址')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加上' })).toBeDisabled()
    expect(submitted).toEqual([])

    // 补上协议就是完整网址：拦不住了。
    await user.type(screen.getByLabelText('地址'), 'X')
    await user.clear(screen.getByLabelText('地址'))
    await user.type(
      screen.getByLabelText('地址'),
      'https://api.example.com/v1'
    )
    expect(screen.getByRole('button', { name: '加上' })).toBeEnabled()
  })

  it('id 是某个账号的名字：两边的命名空间是同一个，先拦下', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await user.type(screen.getByLabelText('平台 id'), 'qoder-2')
    await user.type(screen.getByLabelText('名字'), '撞账号名')
    await user.type(
      screen.getByLabelText('地址'),
      'https://api.example.com/v1'
    )

    expect(screen.getByText('这个 id 已经是账号名')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加上' })).toBeDisabled()
    expect(submitted).toEqual([])
  })

  it('三格都填对了：按钮亮着，交出去的就是这份', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await fillValid(user)
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-other',
        label: '另一个中转站',
        baseUrl: 'https://api.example.com/v1',
        kind: 'openai',
        // 这一类没有默认插件：发空串 = 不用插件。
        quotaPlugin: '',
      },
    ])
  })

  it('新开的空表单：按钮灰着，旁边说清还差哪几格', async () => {
    renderAdd()

    // 一行红字都没敲就先骂起来没有意义：这时候差别在于「还差哪几格」，
    // 不摆三句红字。
    expect(screen.queryByText('平台 id 没有填')).not.toBeInTheDocument()
    expect(screen.queryByText('平台名没有填')).not.toBeInTheDocument()
    expect(screen.queryByText('地址没有填')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加上' })).toBeDisabled()
    expect(screen.getByText('还差：平台 id、名字、地址')).toBeInTheDocument()

    // 填满一格，那一格就从这句话里消失。
    await userEvent
      .setup({ delay: null })
      .type(screen.getByLabelText('平台 id'), 'my-other')
    expect(screen.getByText('还差：名字、地址')).toBeInTheDocument()
  })
})

describe('用共性表补模型参数', () => {
  /** 改一个平台的弹窗。 */
  function renderEdit(platformMessage: Upstream, submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        platform={platformMessage}
        existing={[]}
        kinds={allKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  /** 开关：判据是它的名字，不看位置。 */
  const toggle = () =>
    screen.getByRole('switch', { name: '用共性表补模型参数' })

  it('编辑开放平台：开关摆着、默认关，没动过就不带这一格', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderEdit(platform)

    expect(toggle()).not.toBeChecked()
    expect(
      screen.getByText('平台没报的能力参数按模型 id 从共性表取')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted).toHaveLength(1)
    // 没动过就不带：后端「没给 = 别动这一格」，带一个当前值是替用户写一遍。
    expect(submitted[0]).not.toHaveProperty('traitsFromCommon')
  })

  it('打开开关再保存：带 true，别的格照旧（不多带一格）', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderEdit(platform)

    await user.click(toggle())
    expect(toggle()).toBeChecked()
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted[0]).toEqual({
      id: 'my-gateway',
      label: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      quotaPlugin: 'qiniu-portal',
      modelsAuto: true,
      models: [],
      traitsFromCommon: true,
    })
    expect(submitted[0]).not.toHaveProperty('kind')
  })

  it('关掉开关再保存：带 false（明确关掉与「没给」不是一回事）', async () => {
    const user = userEvent.setup({ delay: null })
    // 服务端说这个平台开着这一格：开关得照着它显示。
    const submitted = renderEdit(
      create(UpstreamSchema, {
        id: 'my-gateway',
        kind: 'openai',
        label: '我的中转站',
        baseUrl: 'https://api.example.com/v1',
        quotaPlugin: 'qiniu-portal',
        modelsAuto: true,
        models: [],
        isOpenPlatform: true,
        fromRow: true,
        traitsFromCommon: true,
        accounts: [],
      })
    )

    expect(toggle()).toBeChecked()
    await user.click(toggle())
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted[0]).toHaveProperty('traitsFromCommon', false)
  })

  it('模拟客户端的编辑弹窗：没有这个开关', () => {
    renderEdit(simulatedPlatform)

    // 那一族的参数归代码，摆一个改了也不算数的开关只会让人以为要选。
    expect(
      screen.queryByRole('switch', { name: '用共性表补模型参数' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('平台没报的能力参数按模型 id 从共性表取')
    ).not.toBeInTheDocument()
  })

  it('服务端没报这一格：按关显示，不报错，提交也不带', async () => {
    const user = userEvent.setup({ delay: null })
    const message = create(UpstreamSchema, {
      id: 'my-gateway',
      kind: 'openai',
      label: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      modelsAuto: true,
      models: [],
      isOpenPlatform: true,
      fromRow: true,
      accounts: [],
    })
    delete (message as { traitsFromCommon?: boolean }).traitsFromCommon

    const submitted = renderEdit(message)

    // 老服务端不报这一格：按关显示，不摆「还在加载」这类话。
    expect(toggle()).not.toBeChecked()
    expect(screen.queryByText(/还在加载/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0]).not.toHaveProperty('traitsFromCommon')
  })
})

/**
 * 新建平台时按类型预填的两格：地址与额度插件。
 *
 * 两格都取自服务端给的类型清单（`default_base_url` 与 `default_quota_plugin`）：
 * 面板不写死这几个平台各自的地址与插件 id。
 */
const vendorKinds: PlatformKindList = {
  status: 'ready',
  kinds: [
    create(PlatformKindSchema, {
      kind: 'openai',
      label: 'OpenAI 兼容',
      category: 'dialect',
      defaultBaseUrl: '',
      defaultQuotaPlugin: '',
      modelsFromUpstream: true,
    }),
    create(PlatformKindSchema, {
      kind: 'qiniu',
      label: '七牛云',
      category: 'dialect',
      defaultBaseUrl: 'https://api.qnaigc.com/v1',
      defaultQuotaPlugin: 'qiniu',
      modelsFromUpstream: false,
    }),
    create(PlatformKindSchema, {
      kind: 'xinghuo',
      label: '讯飞星火',
      category: 'dialect',
      defaultBaseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
      defaultQuotaPlugin: '',
      modelsFromUpstream: true,
    }),
  ],
}

describe('新建平台：按类型预填地址与额度插件', () => {
  /** 新建弹窗（清单里有那三家）。 */
  function renderAdd(submitted: unknown[] = []) {
    render(
      <PlatformDialog
        open
        existing={[]}
        kinds={vendorKinds}
        registry={{ status: 'ready', plugins }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )
    return submitted
  }

  it('选七牛云：地址与额度插件都按这一类预填', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, '七牛云')

    expect(screen.getByLabelText('地址')).toHaveValue(
      'https://api.qnaigc.com/v1'
    )
    // 下拉里摆的是插件自己的名字。
    expect(screen.getByRole('combobox', { name: '额度插件' })).toHaveTextContent(
      '七牛云资源包'
    )

    await user.type(screen.getByLabelText('平台 id'), 'my-qiniu')
    await user.type(screen.getByLabelText('名字'), '我的七牛')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-qiniu',
        label: '我的七牛',
        kind: 'qiniu',
        baseUrl: 'https://api.qnaigc.com/v1',
        // 预填的那一格也交上去：发的是插件 id。
        quotaPlugin: 'qiniu',
      },
    ])
  })

  it('选讯飞星火：地址按这一类预填，额度插件留空', async () => {
    const user = userEvent.setup({ delay: null })
    renderAdd()

    await pickKind(user, '讯飞星火')

    expect(screen.getByLabelText('地址')).toHaveValue(
      'https://maas-api.cn-huabei-1.xf-yun.com/v2'
    )
    // 这一类没有额度接口：那一格是「不用插件」。
    expect(screen.getByRole('combobox', { name: '额度插件' })).toHaveTextContent(
      '不用插件'
    )
  })

  it('选 OpenAI 兼容：地址与额度插件都空着', async () => {
    const user = userEvent.setup({ delay: null })
    renderAdd()

    await pickKind(user, 'OpenAI 兼容')

    expect(screen.getByLabelText('地址')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '额度插件' })).toHaveTextContent(
      '不用插件'
    )
  })

  it('用户自己选过额度插件：换类型不再覆盖它', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted = renderAdd()

    await pickKind(user, '七牛云')
    // 改成「不用插件」。
    await user.click(screen.getByRole('combobox', { name: '额度插件' }))
    await user.click(await screen.findByRole('option', { name: '不用插件' }))
    // 再换一条类型：这一格是用户自己选的，不跟着默认值走。
    await pickKind(user, '讯飞星火')

    expect(screen.getByRole('combobox', { name: '额度插件' })).toHaveTextContent(
      '不用插件'
    )

    await user.type(screen.getByLabelText('平台 id'), 'my-xinghuo')
    await user.type(screen.getByLabelText('名字'), '我的星火')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-xinghuo',
        label: '我的星火',
        kind: 'xinghuo',
        baseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
        // 用户明确选的「不用插件」：发空串。
        quotaPlugin: '',
      },
    ])
  })
})
