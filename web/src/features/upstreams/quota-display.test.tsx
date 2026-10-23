import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  BalanceSummarySchema,
  CreditSummarySchema,
  ListUpstreamsResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 上游列表里的额度。
 *
 * 三样额度，单位不一样：套餐额度（百分比）、积分（点数）、余额（钱）。
 * 有套餐额度就显示套餐额度，没有才显示积分；余额有就另外显示。
 */
describe('上游列表里的额度', () => {
  it('积分、套餐额度、余额各按各的样子显示', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qoder-cn',
              label: 'Qoder 中国区',
              enabled: true,
              quota: create(UpstreamQuotaSchema, {
                upstreamId: 'qoder-cn',
                accountId: 'qoder-cn',
                credits: create(CreditSummarySchema, {
                  total: 2000,
                  used: 800,
                  remaining: 1200,
                }),
              }),
            }),
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              quota: create(UpstreamQuotaSchema, {
                upstreamId: 'minimax',
                accountId: 'minimax',
                tokenPlan: create(TokenPlanSchema, {
                  windows: [
                    create(TokenPlanWindowSchema, {
                      label: 'general',
                      intervalPercent: 72,
                      weeklyPercent: 15,
                    }),
                  ],
                }),
              }),
            }),
            create(UpstreamSchema, {
              id: 'tokenrhythm',
              label: 'TokenRhythm',
              enabled: true,
              quota: create(UpstreamQuotaSchema, {
                upstreamId: 'tokenrhythm',
                accountId: 'tokenrhythm:1',
                balance: create(BalanceSummarySchema, {
                  availableCny: 42.5,
                  currency: 'CNY',
                }),
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('Qoder 中国区')

    // 积分：点数。
    expect(screen.getByText('积分')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()

    // 套餐额度：百分比，两个窗口。
    expect(screen.getByText('套餐额度')).toBeInTheDocument()
    expect(screen.getByText(/5 小时 剩 72%/)).toBeInTheDocument()
    expect(screen.getByText(/每周 剩 15%/)).toBeInTheDocument()

    // 余额：钱。
    expect(screen.getByText('余额')).toBeInTheDocument()
    expect(screen.getByText('¥42.50')).toBeInTheDocument()
  })

  it('一个上游既有积分又有余额时，两个分开显示，不加起来', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'tokenrhythm',
              label: 'TokenRhythm',
              enabled: true,
              quota: create(UpstreamQuotaSchema, {
                upstreamId: 'tokenrhythm',
                accountId: 'tokenrhythm:1',
                credits: create(CreditSummarySchema, {
                  total: 1200,
                  used: 0,
                  remaining: 1200,
                }),
                balance: create(BalanceSummarySchema, {
                  availableCny: 42.5,
                  currency: 'CNY',
                }),
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('TokenRhythm')
    expect(screen.getByText('积分')).toBeInTheDocument()
    expect(screen.getByText('余额')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    expect(screen.getByText('¥42.50')).toBeInTheDocument()
    // 没有把点数当钱加起来的那个数。
    expect(screen.queryByText(/1,?242\.50/)).not.toBeInTheDocument()
  })

  it('没有额度的上游给一个横杠', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('MiniMax Code')
    expect(screen.queryByText('积分')).not.toBeInTheDocument()
    expect(screen.queryByText('套餐额度')).not.toBeInTheDocument()
    expect(screen.queryByText('余额')).not.toBeInTheDocument()
  })

  it('有套餐额度就显示套餐额度，不并列显示积分', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              quota: create(UpstreamQuotaSchema, {
                upstreamId: 'minimax',
                accountId: 'minimax',
                tokenPlan: create(TokenPlanSchema, {
                  windows: [
                    create(TokenPlanWindowSchema, {
                      label: 'general',
                      intervalPercent: 72,
                      weeklyPercent: 15,
                    }),
                  ],
                }),
                credits: create(CreditSummarySchema, {
                  total: 2000,
                  used: 800,
                  remaining: 1200,
                }),
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('MiniMax Code')
    expect(screen.getByText('套餐额度')).toBeInTheDocument()
    expect(screen.queryByText('积分')).not.toBeInTheDocument()
  })
})
