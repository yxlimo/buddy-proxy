import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BenefitStatusSchema,
  GetBenefitStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  RunBenefitNowResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'
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

/** 一个平台，带着它名下的账号。 */
function platform(
  id: string,
  label: string,
  accounts: { id: string; alias: string }[]
) {
  return create(UpstreamSchema, {
    id,
    kind: id,
    label,
    region: 'cn',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: accounts.length,
    hasEnabledAccount: accounts.length > 0,
    accounts: accounts.map((row) =>
      create(AccountSchema, {
        id: row.id,
        platform: id,
        alias: row.alias,
        enabled: true,
        status: 'usable',
        credentialCount: 1,
      })
    ),
  })
}

/** 一个签到状态。 */
function benefit(
  overrides: Partial<BenefitStatus> = {}
): BenefitStatus {
  return create(BenefitStatusSchema, {
    upstreamId: 'minimax',
    summary: '今日已签到 +400',
    lines: ['签到 +400 点', '连签 2 天'],
    checkedAt: BigInt(Date.now()),
    credits: 400,
    ok: true,
    ...overrides,
  })
}

type Options = {
  /** 后端给的签到状态。 */
  benefits?: BenefitStatus[]
  /** 签到跑完返回的 lines。 */
  runLines?: string[]
  /** 签到跑完是不是成功。 */
  runOk?: boolean
  /** 签到一直不回来。 */
  runNeverResolves?: boolean
  /** 签到状态取不到。 */
  statusError?: boolean
}

/** 假客户端：记下每次请求。 */
function setup(options: Options = {}) {
  let statusCalls = 0
  let runCalls = 0
  const statusInputs: Record<string, unknown>[] = []
  const runInputs: Record<string, unknown>[] = []

  const client = mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          platform('minimax', 'MiniMax Code', [
            { id: 'minimax', alias: '主账号' },
          ]),
          platform('tokenrhythm', 'TokenRhythm', [
            { id: 'tokenrhythm-1', alias: '租户 1' },
          ]),
        ],
      }),
    ListProviderKinds: () =>
      create(ListProviderKindsResponseSchema, { kinds: [] }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    GetBenefitStatus: (input) => {
      statusCalls += 1
      statusInputs.push(input as unknown as Record<string, unknown>)
      if (options.statusError) {
        throw new Error('网关炸了')
      }
      return create(GetBenefitStatusResponseSchema, {
        benefits: options.benefits ?? [],
      })
    },
    RunBenefitNow: (input) => {
      runCalls += 1
      runInputs.push(input as unknown as Record<string, unknown>)
      if (options.runNeverResolves) {
        return new Promise<never>(() => {})
      }
      return create(RunBenefitNowResponseSchema, {
        ok: options.runOk ?? true,
        lines: options.runLines ?? [],
      })
    },
  })

  return {
    client,
    statusCalls: () => statusCalls,
    runCalls: () => runCalls,
    statusInputs,
    runInputs,
  }
}

/** 展开一个平台。 */
async function expand(
  user: ReturnType<typeof userEvent.setup>,
  platformId: string
) {
  await user.click(
    await screen.findByRole('button', {
      name: `展开 ${platformId} 的账号与凭据`,
    })
  )
}

/** 消息自带的 $typeName 不是请求里的字段。 */
function fieldsOf(input: Record<string, unknown>): string[] {
  return Object.keys(input).filter((key) => key !== '$typeName')
}

describe('平台上的每日签到', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('平台名下的账号在签到列表里：展开后有「每日签到」这一块', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ benefits: [benefit()] })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')

    const block = await screen.findByRole('region', { name: '每日签到' })
    // 后端给的 summary 原样显示。
    expect(within(block).getByText('今日已签到 +400')).toBeInTheDocument()
    // lines 一句一行。
    expect(within(block).getByText('签到 +400 点')).toBeInTheDocument()
    expect(within(block).getByText('连签 2 天')).toBeInTheDocument()
    // 积分有就显示。
    expect(within(block).getByText('+400 点')).toBeInTheDocument()
    // 账号用别名，后面跟着 id。
    expect(within(block).getByText('主账号')).toBeInTheDocument()
  })

  it('签到时间换成本地时间：今天只写时刻', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ benefits: [benefit()] })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')

    const block = await screen.findByRole('region', { name: '每日签到' })
    expect(
      within(block).getByText(/^今天 \d{2}:\d{2}$/)
    ).toBeInTheDocument()
  })

  it('从来没签过：显示「还没签过」，不显示时刻', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      benefits: [
        benefit({ summary: '暂无签到记录', lines: [], checkedAt: 0n, credits: 0, ok: false }),
      ],
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')

    const block = await screen.findByRole('region', { name: '每日签到' })
    expect(within(block).getByText('还没签过')).toBeInTheDocument()
    // 没有记录不是失败。
    expect(within(block).queryByText('未成功')).not.toBeInTheDocument()
    // 没有积分就不显示积分。
    expect(within(block).queryByText('+400 点')).not.toBeInTheDocument()
  })

  it('这个平台的账号没登记签到：整块都不显示', async () => {
    const user = userEvent.setup({ delay: null })
    // 签到列表里只有 minimax 那个账号，tokenrhythm 名下没有。
    const { client } = setup({ benefits: [benefit()] })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'tokenrhythm')

    expect(await screen.findByText('租户 1')).toBeInTheDocument()
    expect(screen.queryByText('每日签到')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '现在签到' })
    ).not.toBeInTheDocument()
  })

  it('点「现在签到」：发 RunBenefitNow，跑完重新取签到状态，并把 lines 显示出来', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, statusCalls, runCalls, statusInputs, runInputs } = setup({
      benefits: [benefit()],
      runLines: ['[minimax] 签到 +400 点；连签 2 天'],
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')
    await screen.findByRole('region', { name: '每日签到' })
    // 展开的时候取过一次签到状态。
    expect(statusCalls()).toBe(1)
    // 签到状态这个请求没有参数。
    expect(fieldsOf(statusInputs[0] ?? {})).toEqual([])

    await user.click(screen.getByRole('button', { name: '现在签到' }))

    await waitFor(() => {
      expect(runCalls()).toBe(1)
    })
    // RunBenefitNow 也没有参数。
    expect(fieldsOf(runInputs[0] ?? {})).toEqual([])
    // 跑完重新取一次签到状态。
    await waitFor(() => {
      expect(statusCalls()).toBe(2)
    })
    // 返回的 lines 逐行显示出来。
    expect(
      await screen.findByText('[minimax] 签到 +400 点；连签 2 天')
    ).toBeInTheDocument()
  })

  it('签到没成功（ok=false）：lines 照样显示出来，并说清有账号没成功', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      benefits: [
        benefit({ summary: '签到未成功', lines: ['凭据被上游拒了'], ok: false }),
      ],
      runOk: false,
      runLines: ['[minimax] 凭据被上游拒了'],
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')
    await screen.findByRole('region', { name: '每日签到' })

    await user.click(screen.getByRole('button', { name: '现在签到' }))

    // 失败也把 lines 显示出来，不只说一句「失败」。
    expect(
      await screen.findByText('[minimax] 凭据被上游拒了')
    ).toBeInTheDocument()
    expect(
      screen.getByText('本次签到（有账号没成功）')
    ).toBeInTheDocument()
    // 账号那一行也标成没成功。
    expect(screen.getByText('未成功')).toBeInTheDocument()
    expect(screen.getByText('凭据被上游拒了')).toBeInTheDocument()
  })

  it('签到进行中：按钮禁用，文字变成「签到中」', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, runCalls } = setup({
      benefits: [benefit()],
      runNeverResolves: true,
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')
    await screen.findByRole('region', { name: '每日签到' })

    await user.click(screen.getByRole('button', { name: '现在签到' }))

    const running = await screen.findByRole('button', { name: '签到中' })
    expect(running).toBeDisabled()
    expect(runCalls()).toBe(1)
    // 跑着的时候不会再发一次。
    await user.click(running)
    expect(runCalls()).toBe(1)
  })

  it('签到状态取不到：给错误与重试，不假装是没有签到', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ statusError: true })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await expand(user, 'minimax')

    expect(await screen.findByText(/网关炸了/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })
})
