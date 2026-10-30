import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import {
  BalanceSummarySchema,
  BenefitStatusSchema,
  CreditSummarySchema,
  GetBenefitStatusResponseSchema,
  GetSystemStatusResponseSchema,
  GetUsageSummaryResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UsageSummarySchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { createAppRouter } from '@/router'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'

/**
 * 总览页。
 *
 * 总览不跨种类求和：余额（钱）、积分（点数）、套餐额度（百分比）单位不同，
 * 加起来没有意义。所以这里没有「可用余额」这一栏。
 */
function renderOverview(client: ReturnType<typeof mockAdminClient>) {
  const queryClient = makeTestQueryClient()
  const router = createAppRouter(queryClient)
  render(
    <QueryClientProvider client={queryClient}>
      <AdminClientProvider client={client}>
        <RouterProvider router={router} />
      </AdminClientProvider>
    </QueryClientProvider>
  )
}

describe('总览页', () => {
  it('没有「可用余额」这一栏', async () => {
    const client = mockAdminClient({
      GetSystemStatus: () =>
        create(GetSystemStatusResponseSchema, {
          version: '1.0.0',
          uptimeSec: 3600n,
          publishedModelCount: 3,
          upstreams: [
            create(UpstreamSchema, {
              id: 'tokenrhythm',
              label: 'TokenRhythm',
              enabled: true,
              modelCount: 2,
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
      GetUsageSummary: () =>
        create(GetUsageSummaryResponseSchema, {
          total: create(UsageSummarySchema, {
            requests: 12n,
            succeeded: 10n,
            failed: 2n,
          }),
        }),
    })

    renderOverview(client)

    await screen.findByRole(
      'heading',
      { name: '总览' },
      // 整套测试一起跑的时候慢一点，别在这儿翻车。
      { timeout: 5000 }
    )

    // 那一栏没了。
    expect(screen.queryByText('可用余额')).not.toBeInTheDocument()
    // 也没有把点数和钱加起来的那种数。
    expect(screen.queryAllByText(/1,?242\.50/)).toHaveLength(0)

    // 别的几栏还在。
    expect(screen.getAllByText('今日请求').length).toBeGreaterThan(0)
    expect(screen.getAllByText('主路由模型').length).toBeGreaterThan(0)
    expect(screen.getAllByText('运行时长').length).toBeGreaterThan(0)
  })

  it('上游列表里的额度分种类显示，不求和', async () => {
    const client = mockAdminClient({
      GetSystemStatus: () =>
        create(GetSystemStatusResponseSchema, {
          version: '1.0.0',
          uptimeSec: 3600n,
          publishedModelCount: 3,
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
      GetUsageSummary: () =>
        create(GetUsageSummaryResponseSchema, {
          total: create(UsageSummarySchema, {
            requests: 1n,
            succeeded: 1n,
            failed: 0n,
          }),
        }),
    })

    renderOverview(client)

    await screen.findByRole(
      'heading',
      { name: '总览' },
      { timeout: 5000 }
    )

    expect(screen.getByText('积分')).toBeInTheDocument()
    // 侧边栏里也有一个「余额」，所以这里按「至少有一个」来断言。
    expect(screen.getAllByText('余额').length).toBeGreaterThan(0)
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    expect(screen.getByText('¥42.50')).toBeInTheDocument()
  })

  it('最上方是每日签到统一区', async () => {
    const client = mockAdminClient({
      GetSystemStatus: () =>
        create(GetSystemStatusResponseSchema, {
          version: '1.0.0',
          uptimeSec: 3600n,
          publishedModelCount: 3,
          upstreams: [],
        }),
      GetUsageSummary: () =>
        create(GetUsageSummaryResponseSchema, {
          total: create(UsageSummarySchema, {
            requests: 1n,
            succeeded: 1n,
            failed: 0n,
          }),
        }),
      GetBenefitStatus: () =>
        create(GetBenefitStatusResponseSchema, {
          benefits: [
            create(BenefitStatusSchema, {
              upstreamId: 'minimax',
              summary: '签到成功',
              lines: [],
              checkedAt: 0n,
              credits: 12,
              ok: true,
            }),
          ],
        }),
    })

    renderOverview(client)

    await screen.findByRole(
      'heading',
      { name: '总览' },
      { timeout: 5000 }
    )

    const checkin = await screen.findAllByText('每日签到')
    expect(checkin.length).toBeGreaterThan(0)
    // 签到区排在今日请求之前。
    const request = screen.getAllByText('今日请求')[0]
    expect(
      checkin[0].compareDocumentPosition(request) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByText('+12 点')).toBeInTheDocument()
  })
})
