import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BalanceSummarySchema,
  GetBalanceResponseSchema,
  ListUpstreamsResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  type UpstreamQuota,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const ENDS_AT = BigInt(Date.UTC(2026, 9, 23, 12, 0, 0))

/** 假客户端：一行平台清单（行集合来自它），加上这一家的额度。 */
function clientWith(upstreamId: string, quotas: UpstreamQuota[]) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [create(UpstreamSchema, { id: upstreamId })],
      }),
    GetBalance: () => create(GetBalanceResponseSchema, { quotas }),
  })
}

/** 摆页面并点开这个平台那一行。 */
async function openPlatform(upstreamId: string) {
  await userEvent
    .setup({ delay: null })
    .click(await screen.findByRole('button', { name: new RegExp(`^${upstreamId}`) }))
}

/** 一个带套餐额度窗口的账号。 */
function planQuota(percent: { interval: number; weekly: number }) {
  return create(UpstreamQuotaSchema, {
    upstreamId: 'minimax',
    accountId: 'minimax',
    tokenPlan: create(TokenPlanSchema, {
      windows: [
        create(TokenPlanWindowSchema, {
          label: 'general',
          intervalPercent: percent.interval,
          weeklyPercent: percent.weekly,
          intervalEndsAt: ENDS_AT,
          weeklyEndsAt: ENDS_AT,
        }),
      ],
    }),
  })
}

/**
 * 套餐额度：MiniMax 的 5 小时窗口与周窗口各剩多少。
 *
 * 以前这些只在 /health 里能看到，面板上没有。明细在展开之后的那一区。
 */
describe('套餐额度', () => {
  it('每个窗口一行，显示两个窗口的剩余百分比和重置时间', async () => {
    const client = clientWith('minimax', [planQuota({ interval: 72, weekly: 15 })])

    renderWithClient({ client, children: <BalancePage /> })
    await openPlatform('minimax')

    await screen.findByText('通用')
    expect(screen.getByText('剩 72%')).toBeInTheDocument()
    expect(screen.getByText('剩 15%')).toBeInTheDocument()
    // 重置时间给出来了。
    expect(screen.getAllByText(/重置/).length).toBeGreaterThan(0)
  })

  it('两个窗口的名字写清楚：5 小时和每周', async () => {
    const client = clientWith('minimax', [planQuota({ interval: 72, weekly: 15 })])

    renderWithClient({ client, children: <BalancePage /> })
    await openPlatform('minimax')

    await screen.findByText('通用')
    expect(screen.getByText('5 小时')).toBeInTheDocument()
    expect(screen.getByText('每周')).toBeInTheDocument()
  })

  it('没有套餐额度的时候不显示那一块', async () => {
    const client = clientWith('tokenrhythm', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'tokenrhythm',
        accountId: 'tokenrhythm:1',
        balance: create(BalanceSummarySchema, {
          availableCny: 12.5,
          currency: 'CNY',
        }),
      }),
    ])

    renderWithClient({ client, children: <BalancePage /> })
    await openPlatform('tokenrhythm')

    await screen.findByText('最早到期')
    expect(screen.getAllByText('¥12.50').length).toBeGreaterThan(0)
    expect(screen.queryByText('套餐额度')).not.toBeInTheDocument()
  })
})
