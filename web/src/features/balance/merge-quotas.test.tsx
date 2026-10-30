import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  BalanceSummarySchema,
  CreditLotSchema,
  CreditSummarySchema,
  GetBalanceResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage, mergeQuotas } from '@/features/balance/index'
import { CreditLotsTable } from '@/features/balance/credit-lots'
import { TokenPlanPanel } from '@/features/balance/token-plan'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 契约里的时间戳是 Unix 毫秒。 */
const SOON = BigInt(Date.UTC(2030, 0, 15))
const LATER = BigInt(Date.UTC(2031, 5, 1))
/** 平台用 2099-12-31 标记「永不过期」。 */
const NEVER = BigInt(Date.UTC(2099, 11, 31))

/**
 * 归并：同一账号的多条额度记录只渲染一张卡。
 *
 * 单位不同（套餐额度是百分点，积分是点数，余额是钱），所以归并不求和。
 */
describe('额度归并', () => {
  it('把同一账号的两条记录并成一条，各取第一个带数的，不求和', () => {
    const merged = mergeQuotas([
      create(UpstreamQuotaSchema, {
        upstreamId: 'minimax',
        accountId: 'acc-1',
        tokenPlan: create(TokenPlanSchema, { windows: [] }),
        credits: create(CreditSummarySchema, {
          total: 100,
          used: 40,
          remaining: 60,
        }),
      }),
      create(UpstreamQuotaSchema, {
        upstreamId: 'minimax',
        accountId: 'acc-1',
        tokenPlan: create(TokenPlanSchema, {
          windows: [
            create(TokenPlanWindowSchema, {
              label: 'general',
              intervalPercent: 80,
              weeklyPercent: 40,
            }),
          ],
        }),
        credits: create(CreditSummarySchema, {
          total: 200,
          used: 100,
          remaining: 100,
        }),
        balance: create(BalanceSummarySchema, {
          availableCny: 12.5,
          currency: 'CNY',
        }),
      }),
      create(UpstreamQuotaSchema, {
        upstreamId: 'qoder-cn',
        accountId: 'acc-2',
        credits: create(CreditSummarySchema, {
          total: 7,
          used: 0,
          remaining: 7,
        }),
      }),
    ])

    // 两个账号，两条记录。
    expect(merged).toHaveLength(2)

    const first = merged[0]
    expect(first.upstreamId).toBe('minimax')
    expect(first.accountId).toBe('acc-1')
    // 套餐额度取第一个有窗口的那条。
    expect(first.tokenPlan?.windows).toHaveLength(1)
    // 积分取第一个带数的那条，不相加（60 + 100 = 160）。
    expect(first.credits?.remaining).toBe(60)
    // 余额只有第二条有，取那一条。
    expect(first.balance?.availableCny).toBe(12.5)

    // 首次出现的顺序保留。
    expect(merged[1].upstreamId).toBe('qoder-cn')
    expect(merged[1].accountId).toBe('acc-2')
  })

  it('面板上同一账号只有一张卡', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'acc-1',
              credits: create(CreditSummarySchema, {
                total: 100,
                used: 0,
                remaining: 100,
              }),
            }),
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'acc-1',
              credits: create(CreditSummarySchema, {
                total: 200,
                used: 0,
                remaining: 200,
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('acc-1')
    // 一张卡：账号名只出现一次。
    expect(screen.getAllByText('acc-1')).toHaveLength(1)
  })
})

/**
 * 积分批次：只留还有点的批次，按到期时间排。
 */
describe('积分批次', () => {
  it('不渲染已经没点的批次', () => {
    render(
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-empty',
            remaining: 0,
            expiresAt: SOON,
            status: 'active',
          }),
          create(CreditLotSchema, {
            id: 'lot-alive',
            remaining: 5,
            expiresAt: SOON,
            status: 'active',
          }),
        ]}
      />,
    )

    expect(screen.queryByText('lot-empty')).toBeNull()
    expect(screen.getByText('lot-alive')).toBeInTheDocument()
  })

  it('按到期时间升序排，永不过期的排最后', () => {
    render(
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-never',
            remaining: 9,
            expiresAt: NEVER,
            status: 'active',
          }),
          create(CreditLotSchema, {
            id: 'lot-late',
            remaining: 8,
            expiresAt: LATER,
            status: 'active',
          }),
          create(CreditLotSchema, {
            id: 'lot-soon',
            remaining: 7,
            expiresAt: SOON,
            status: 'active',
          }),
        ]}
      />,
    )

    const ids = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '')
    expect(ids[0]).toContain('lot-soon')
    expect(ids[1]).toContain('lot-late')
    expect(ids[2]).toContain('lot-never')
  })
})

/**
 * 套餐额度：重置时间常态显示，不看百分比。
 */
describe('套餐额度的重置时间', () => {
  it('百分比还有的时候也显示重置时间', () => {
    const endsAt = BigInt(Date.now() + 3 * 60 * 60 * 1000)
    render(
      <TokenPlanPanel
        windows={[
          create(TokenPlanWindowSchema, {
            label: 'general',
            intervalPercent: 80,
            weeklyPercent: 40,
            intervalEndsAt: endsAt,
            weeklyEndsAt: endsAt,
          }),
        ]}
      />,
    )

    expect(screen.getAllByText(/重置：/)).toHaveLength(2)
    expect(screen.getAllByText(/剩 \d+ 小时/)).toHaveLength(2)
  })

  it('平台没给重置时间的时候明说', () => {
    render(
      <TokenPlanPanel
        windows={[
          create(TokenPlanWindowSchema, {
            label: 'general',
            intervalPercent: 80,
            weeklyPercent: 40,
          }),
        ]}
      />,
    )

    expect(screen.getAllByText('平台未给重置时间')).toHaveLength(2)
    expect(screen.queryByText(/重置：/)).toBeNull()
  })
})
