import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BenefitStatusSchema,
  GetBenefitStatusResponseSchema,
  ListUpstreamsResponseSchema,
  RunBenefitNowResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'
import { CheckinPage } from '@/features/benefits/checkin-page'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 平台清单里的一行。签到页的行集合来自它。 */
function platform(
  id: string,
  label = '',
  accounts: { id: string; alias: string }[] = [],
) {
  return create(UpstreamSchema, {
    id,
    label,
    accounts: accounts.map((a) => create(AccountSchema, a)),
  })
}

/** 一份平台清单。 */
function platformList(upstreams: ReturnType<typeof platform>[]) {
  return create(ListUpstreamsResponseSchema, { upstreams })
}

/** 一条签到状态。 */
function benefit(overrides: Partial<BenefitStatus> = {}): BenefitStatus {
  return create(BenefitStatusSchema, {
    upstreamId: 'minimax',
    accountId: '1',
    summary: '今日已签到',
    lines: [],
    checkedAt: 0n,
    credits: 0,
    ok: true,
    ...overrides,
  })
}

type Options = {
  upstreams?: ReturnType<typeof platform>[]
  benefits?: BenefitStatus[]
  runLines?: string[]
  runOk?: boolean
}

/** 假客户端：记下每次请求。 */
function setup(options: Options = {}) {
  let statusCalls = 0
  let runCalls = 0

  const client = mockAdminClient({
    ListUpstreams: () => platformList(options.upstreams ?? []),
    GetBenefitStatus: () => {
      statusCalls += 1
      return create(GetBenefitStatusResponseSchema, {
        benefits: options.benefits ?? [],
      })
    },
    RunBenefitNow: () => {
      runCalls += 1
      return create(RunBenefitNowResponseSchema, {
        ok: options.runOk ?? true,
        lines: options.runLines ?? [],
      })
    },
  })

  return { client, statusCalls: () => statusCalls, runCalls: () => runCalls }
}

/**
 * 一个平台一行，默认收起。
 */
describe('签到页', () => {
  it('没有签到记录的平台也占一行', async () => {
    const { client } = setup({
      upstreams: [platform('minimax'), platform('qoder-cn')],
      benefits: [benefit({ upstreamId: 'minimax', accountId: 'a1' })],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const minimax = await screen.findByRole('listitem', {
      name: 'minimax 签到行',
    })
    expect(within(minimax).getByText('今日已签到')).toBeInTheDocument()

    const qoder = screen.getByRole('listitem', { name: 'qoder-cn 签到行' })
    expect(within(qoder).getByText('没有签到记录')).toBeInTheDocument()
  })

  it('平台显示名用 label，没有 label 用 id', async () => {
    const { client } = setup({
      upstreams: [platform('minimax', 'MiniMax'), platform('qoder-cn')],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const minimax = await screen.findByRole('listitem', {
      name: 'minimax 签到行',
    })
    expect(within(minimax).getByText('MiniMax')).toBeInTheDocument()

    const qoder = screen.getByRole('listitem', { name: 'qoder-cn 签到行' })
    expect(within(qoder).getByText('qoder-cn')).toBeInTheDocument()
  })

  it('默认收起：明细不在，点开才出现', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({
          upstreamId: 'minimax',
          accountId: 'a1',
          summary: '今日已签到',
          lines: ['minimax: +12 点'],
          checkedAt: 1_700_000_000_000n,
          credits: 12,
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const toggle = await screen.findByRole('button', { name: 'minimax 签到' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'minimax 签到明细' }),
    ).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByRole('region', { name: 'minimax 签到明细' })
    expect(within(detail).getByText('minimax: +12 点')).toBeInTheDocument()
    expect(within(detail).getByText(/上次签到/)).toBeInTheDocument()
  })

  it('展开明细按账号列出，账号用别名，拿不到退回 id', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      upstreams: [
        platform('minimax', 'MiniMax', [
          { id: 'a1', alias: '主号' },
          { id: 'a2', alias: '' },
        ]),
      ],
      benefits: [
        benefit({ upstreamId: 'minimax', accountId: 'a1', credits: 5 }),
        benefit({
          upstreamId: 'minimax',
          accountId: 'a2',
          summary: '签到未成功',
          ok: false,
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const toggle = await screen.findByRole('button', { name: 'minimax 签到' })
    await user.click(toggle)

    const detail = screen.getByRole('region', { name: 'minimax 签到明细' })
    expect(within(detail).getByText('主号')).toBeInTheDocument()
    // 没有别名的账号退回显示 id
    expect(within(detail).getByText('a2')).toBeInTheDocument()
    expect(within(detail).getByText('签到未成功')).toBeInTheDocument()
  })

  it('点「立即签到」调 RunBenefitNow 并逐条显示返回的 lines', async () => {
    const { client, runCalls, statusCalls } = setup({
      upstreams: [platform('minimax')],
      runLines: ['minimax: +12 点', 'qoder-cn: +8 点'],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const button = await screen.findByRole('button', { name: '立即签到' })
    await userEvent.click(button)

    await waitFor(() => {
      expect(runCalls()).toBe(1)
    })
    const result = await screen.findByLabelText('本次签到')
    expect(within(result).getByText('minimax: +12 点')).toBeInTheDocument()
    expect(within(result).getByText('qoder-cn: +8 点')).toBeInTheDocument()

    // 签到跑完要重新取一次签到状态
    await waitFor(() => {
      expect(statusCalls()).toBeGreaterThan(1)
    })
  })
})
