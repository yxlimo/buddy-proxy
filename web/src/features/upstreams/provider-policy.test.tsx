import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Code, ConnectError } from '@connectrpc/connect'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  SetPlatformPolicyResponseSchema,
  UpstreamSchema,
  UpstreamState,
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
 * 策略的中文标签。
 *
 * 后端给的话长这样（lib/platforms.ts 的 POLICY_TEXT）：「策略改成了降级」。这里
 * 照着后端的形状回，断言的才是用户真正看到的那句话。
 */
const POLICY_LABEL: Partial<Record<ProviderPolicy, string>> = {
  [ProviderPolicy.SINGLE]: '单一',
  [ProviderPolicy.FALLBACK]: '降级',
  [ProviderPolicy.EXPIRY_FIRST]: '余额到期优先',
}

type Options = {
  /** 平台当前的策略。 */
  policy?: ProviderPolicy
  /** 后端说这个平台支持哪些策略。 */
  policies?: ProviderPolicy[]
  /** 后端给的账号数。 */
  accountCount?: number
  /** 账号列表里有几个账号（跟后端给的账号数不是一回事）。 */
  listedAccounts?: number
  /** 改策略的答复。 */
  answer?: (input: { platform?: string; policy?: ProviderPolicy }) => {
    ok: boolean
    message?: string
  }
  /** 保存成功之后列表再取回来时给的策略：服务端没落库，或者别的面板改了。 */
  listPolicyAfterSave?: ProviderPolicy
  /** 服务端回了 ok，但策略没落库（写库那步没生效）。 */
  saveDoesNotApply?: boolean
  /** 保存一直不回来：看请求在飞的时候显示的是什么。 */
  saveNeverResolves?: boolean
  /** 保存时传输层报错（不是 ok:false）。 */
  saveTransportError?: Error
}

/** 一个带账号的假平台：策略选择器要看的东西都在这上面。 */
function setup(options: Options = {}) {
  const policy = options.policy ?? ProviderPolicy.SINGLE
  const policies = options.policies ?? [
    ProviderPolicy.SINGLE,
    ProviderPolicy.FALLBACK,
    ProviderPolicy.EXPIRY_FIRST,
  ]
  const accountCount = options.accountCount ?? 2
  const listedAccounts = options.listedAccounts ?? accountCount
  // 记下每次改策略的请求：整个请求体都要看，别只看挑出来的字段。
  const sent: {
    platform: string
    policy: ProviderPolicy
    fields: string[]
  }[] = []
  // 服务端记住的当前策略：保存成功就变，列表重新取的时候带回来。
  let currentPolicy = policy
  let saved = false

  const accounts = Array.from({ length: listedAccounts }, (_, index) =>
    create(AccountSchema, {
      id: `tokenrhythm-${index + 1}`,
      platform: 'tokenrhythm',
      alias: `租户 ${index + 1}`,
      enabled: true,
      status: 'usable',
      credentialCount: 1,
    })
  )

  const client = mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          create(UpstreamSchema, {
            id: 'tokenrhythm',
            kind: 'tokenrhythm',
            label: 'TokenRhythm',
            state: UpstreamState.READY,
            hasEnabledAccount: listedAccounts > 0,
            policy:
              saved && options.listPolicyAfterSave !== undefined
                ? options.listPolicyAfterSave
                : currentPolicy,
            policies,
            accountCount,
            accounts,
          }),
        ],
      }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    SetPlatformPolicy: (input) => {
      // 消息实例上的字段都是实打实的值，但类型上是可选的（init 的形状）。
      const raw = input as unknown as Record<string, unknown>
      sent.push({
        platform: raw.platform as string,
        policy: raw.policy as ProviderPolicy,
        // $typeName 是 protobuf 消息自带的标记，不是请求里的字段。排序后再比：
        // 字段顺序变了不该让测试红。
        fields: Object.keys(raw)
          .filter((key) => key !== '$typeName')
          .sort(),
      })
      if (options.saveNeverResolves) {
        // 一直不回来：看请求在飞的时候触发器显示的是什么。
        return new Promise<never>(() => {})
      }
      if (options.saveTransportError) {
        throw options.saveTransportError
      }
      const answer = options.answer?.(input)
      const ok = answer?.ok ?? true
      if (ok && !options.saveDoesNotApply) {
        currentPolicy = raw.policy as ProviderPolicy
        saved = true
      }
      return create(SetPlatformPolicyResponseSchema, {
        ok,
        message:
          answer?.message ??
          `策略改成了${
            POLICY_LABEL[raw.policy as ProviderPolicy] ?? '单一'
          }`,
      })
    },
  })

  return { client, sent }
}

/** 在下拉里选一个策略。 */
async function pickPolicy(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp | string
) {
  const select = await screen.findByRole('combobox', { name: /^生效策略/ })
  await waitFor(() => {
    expect(select).toBeEnabled()
  })
  await user.click(select)
  await user.click(await screen.findByRole('option', { name }))
}

/** 策略选择器。 */
function trigger() {
  return screen.getByRole('combobox', { name: /^生效策略/ })
}

describe('平台的生效策略', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('平台的这一行上就有「生效策略」选择器，不用展开', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    expect(
      await screen.findByRole('combobox', { name: /^生效策略/ })
    ).toBeInTheDocument()
    // 没展开也看不到账号。
    expect(screen.queryByText('租户 1')).not.toBeInTheDocument()
    expect(user).toBeTruthy()
  })

  it('当前值来自平台的策略', async () => {
    const { client } = setup({ policy: ProviderPolicy.EXPIRY_FIRST })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('余额到期优先')
    })
  })

  it('可选的策略来自平台这一行，后端没给的就不显示', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      policies: [ProviderPolicy.SINGLE, ProviderPolicy.FALLBACK],
    })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await user.click(trigger())

    expect(
      await screen.findByRole('option', { name: '单一' })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '降级' })).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: '余额到期优先' })
    ).not.toBeInTheDocument()
  })

  it('后端没给这个平台列出策略：没有可选的', async () => {
    const { client } = setup({ policies: [] })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toBeDisabled()
    })
    expect(screen.getByText('这个平台没有可选策略')).toBeInTheDocument()
  })

  it('换策略走 SetPlatformPolicy，请求体里只有平台 id 和策略', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, sent } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '降级')

    await waitFor(() => {
      expect(sent).toEqual([
        {
          platform: 'tokenrhythm',
          policy: ProviderPolicy.FALLBACK,
          // 别名不跟着走：策略有自己的方法，不碰 UpdateProvider。
          fields: ['platform', 'policy'],
        },
      ])
    })
  })

  it('只有一个账号：选择器禁用，并说清楚策略不生效', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, sent } = setup({ accountCount: 1 })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toBeDisabled()
    })
    expect(
      screen.getByText('这个平台只有一个账号，策略不生效')
    ).toBeInTheDocument()
    // 禁用状态下选不了，也就发不出请求。
    expect(sent).toEqual([])
    expect(user).toBeTruthy()
  })

  it('账号数由后端给：账号列表说两个、后端说一个，按后端的禁用', async () => {
    const { client } = setup({ accountCount: 1, listedAccounts: 2 })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toBeDisabled()
    })
    expect(
      screen.getByText('这个平台只有一个账号，策略不生效')
    ).toBeInTheDocument()
  })

  it('账号数由后端给：账号列表说一个、后端说两个，按后端的可用', async () => {
    const { client } = setup({ accountCount: 2, listedAccounts: 1 })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toBeEnabled()
    })
  })

  it('没有账号：不禁用，策略先设着', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, sent } = setup({ accountCount: 0, listedAccounts: 0 })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toBeEnabled()
    })
    expect(
      screen.getByText('这个平台还没有账号，策略先设着')
    ).toBeInTheDocument()

    await pickPolicy(user, '降级')

    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
  })

  it('保存成功给一个提示，选择器停在新选的策略上', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '余额到期优先')

    // 后端给的话是「策略改成了余额到期优先」，面板原样给用户看。
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('策略改成了余额到期优先')
    })
    expect(toastError).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('余额到期优先')
    })
  })

  it('服务端没给消息：用面板的兜底文案', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ answer: () => ({ ok: true, message: '' }) })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '降级')

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('策略改好了')
    })
  })

  it('列表取回来的值是另一个策略：选择器最终显示服务端给的那个', async () => {
    const user = userEvent.setup({ delay: null })
    // 服务端给的不是刚选的那个（保存没落库，或者别的面板改了）。
    const { client } = setup({ listPolicyAfterSave: ProviderPolicy.EXPIRY_FIRST })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '降级')

    await waitFor(() => {
      expect(trigger()).toHaveTextContent('余额到期优先')
    })
  })

  it('列表取回来的值没变（服务端没落库）：还是显示服务端给的那个', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ saveDoesNotApply: true })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('单一')
    })
    await pickPolicy(user, '降级')

    // 列表取回来了，值还是单一：面板不能停在用户刚选的值上。
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('单一')
    })
  })

  it('请求在飞的时候：触发器显示刚选的值', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, sent } = setup({ saveNeverResolves: true })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '降级')

    // 保存还没回来：显示的是刚选的，不是服务端的旧值。
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('降级')
    })
    expect(sent).toHaveLength(1)
  })

  it('保存失败给一个错误提示，选择器回到服务端给的值', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      answer: () => ({ ok: false, message: '这个平台不支持余额到期优先' }),
    })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    expect(trigger()).toHaveTextContent('单一')

    await pickPolicy(user, '余额到期优先')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('这个平台不支持余额到期优先')
    })
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('单一')
    })
  })

  it('保存时传输层报错：给出错误提示，选择器回到服务端给的值', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      saveTransportError: new ConnectError('网关炸了', Code.Unavailable),
    })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    await pickPolicy(user, '降级')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('网关不可用：网关炸了')
    })
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('单一')
    })
  })

  it('服务端给的当前值不在选项里：显示当前值，并说清楚这个平台没有这个选项', async () => {
    const user = userEvent.setup({ delay: null })
    // 库里存着降级，但这一类平台只登记了单一。
    const { client } = setup({
      policy: ProviderPolicy.FALLBACK,
      policies: [ProviderPolicy.SINGLE],
    })
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')

    // 不是「未设置」：服务端有值，面板就说有值。
    expect(trigger()).toHaveTextContent('降级')
    expect(
      screen.getByText('当前：降级（这个平台没有这个选项）')
    ).toBeInTheDocument()

    // 这个值在选项里补上了，标成「当前」且不可选。
    await user.click(trigger())
    const outside = await screen.findByRole('option', { name: '降级（当前）' })
    expect(outside).toHaveAttribute('data-disabled')
  })

  it('说明文字跟选择器关联在一起', async () => {
    const { client } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')

    const describedBy = trigger().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = document.getElementById(describedBy as string)
    expect(description).not.toBeNull()
    // 状态变了要念出来：禁用、换成别的策略。
    expect(description).toHaveAttribute('aria-live', 'polite')
    expect(description?.textContent).toBe('只用一个账号，不换')
  })
})
