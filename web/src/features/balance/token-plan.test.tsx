import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  BalanceSummarySchema,
  GetBalanceResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const ENDS_AT = BigInt(Date.UTC(2026, 9, 23, 12, 0, 0))

/**
 * 套餐额度：MiniMax 的 5 小时窗口与周窗口各剩多少。
 *
 * 以前这些只在 /health 里能看到，面板上没有。
 */
describe('套餐额度', () => {
  it('每个窗口一行，显示两个窗口的剩余百分比和重置时间', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'minimax',
              tokenPlan: create(TokenPlanSchema, {
                windows: [
                  create(TokenPlanWindowSchema, {
                    label: 'general',
                    intervalPercent: 72,
                    weeklyPercent: 15,
                    intervalEndsAt: ENDS_AT,
                    weeklyEndsAt: ENDS_AT,
                  }),
                ],
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('套餐额度')
    expect(screen.getByText('通用')).toBeInTheDocument()
    expect(screen.getByText('剩 72%')).toBeInTheDocument()
    expect(screen.getByText('剩 15%')).toBeInTheDocument()
    // 重置时间给出来了。
    expect(screen.getAllByText(/重置/).length).toBeGreaterThan(0)
  })

  it('两个窗口的名字写清楚：5 小时和每周', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'minimax',
              tokenPlan: create(TokenPlanSchema, {
                windows: [
                  create(TokenPlanWindowSchema, {
                    label: 'general',
                    intervalPercent: 72,
                    weeklyPercent: 15,
                    intervalEndsAt: ENDS_AT,
                    weeklyEndsAt: ENDS_AT,
                  }),
                ],
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('套餐额度')
    expect(screen.getByText('5 小时')).toBeInTheDocument()
    expect(screen.getByText('每周')).toBeInTheDocument()
  })

  it('没有套餐额度的时候不显示那一块', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'tokenrhythm',
              accountId: 'tokenrhythm:1',
              balance: create(BalanceSummarySchema, {
                availableCny: 12.5,
                currency: 'CNY',
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText(/¥12\.50/)
    expect(screen.queryByText('套餐额度')).not.toBeInTheDocument()
  })
})
