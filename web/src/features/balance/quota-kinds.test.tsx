import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  BalanceLotSchema,
  BalanceSummarySchema,
  CreditLotSchema,
  CreditSummarySchema,
  GetBalanceResponseSchema,
  UpstreamQuotaSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const EXPIRES_AT = BigInt(Date.UTC(2030, 0, 15))

/**
 * 额度分三种：余额（钱）、积分（点数）、套餐额度（百分比）。
 *
 * 三者不叠加、不换算、不求和 —— 单位不同，加起来的数没有意义。
 */
describe('额度按种类渲染', () => {
  it('积分账号显示点数，不写成钱', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'qoder-cn',
              accountId: 'qoder-cn',
              credits: create(CreditSummarySchema, {
                total: 2000,
                used: 800,
                remaining: 1200,
                note: '每天 100 点，连签 3 天',
                lots: [
                  create(CreditLotSchema, {
                    id: 'credit-1',
                    sourceLabel: '套餐额度',
                    remaining: 1200,
                    expiresAt: EXPIRES_AT,
                    status: 'active',
                  }),
                ],
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('积分')
    // 剩余、总额、已用都是点数。
    expect(screen.getAllByText('1,200 点').length).toBeGreaterThan(0)
    expect(screen.getByText('2,000 点')).toBeInTheDocument()
    expect(screen.getByText('800 点')).toBeInTheDocument()
    // 明细也在。
    expect(screen.getByText('credit-1')).toBeInTheDocument()
    expect(screen.getByText('每天 100 点，连签 3 天')).toBeInTheDocument()
    // 点数不是钱。
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument()
  })

  it('平台没报总额的时候不硬凑总额和已用', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'workbuddy-cn',
              accountId: 'workbuddy-cn',
              credits: create(CreditSummarySchema, {
                total: 0,
                used: 0,
                remaining: 42,
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('积分')
    expect(screen.getByText('42 点')).toBeInTheDocument()
    expect(screen.queryByText('总额')).not.toBeInTheDocument()
    expect(screen.queryByText('已用')).not.toBeInTheDocument()
  })

  it('余额账号显示钱、明细、最早到期和会过期的那部分', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'tokenrhythm',
              accountId: 'tokenrhythm:1',
              balance: create(BalanceSummarySchema, {
                availableCny: 42.5,
                currency: 'CNY',
                nextExpiryAt: EXPIRES_AT,
                expiringCny: 10,
                lots: [
                  create(BalanceLotSchema, {
                    id: 'balance-1',
                    sourceLabel: '新人活动',
                    remainingCny: 42.5,
                    expiresAt: EXPIRES_AT,
                    status: 'active',
                  }),
                ],
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 页面标题也是「余额」，所以这里按「至少有一个」来断言。
    await screen.findByText('最早到期')
    expect(screen.getAllByText('余额').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥42.50').length).toBeGreaterThan(0)
    expect(screen.getByText('会过期的那部分')).toBeInTheDocument()
    expect(screen.getByText('¥10.00')).toBeInTheDocument()
    expect(screen.getByText('balance-1')).toBeInTheDocument()
  })

  it('积分和余额各是各的，不加在一起', async () => {
    const client = mockAdminClient({
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
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
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('积分')
    expect(screen.getAllByText('余额').length).toBeGreaterThan(0)
    // 两个数都在。
    expect(screen.getAllByText('1,200 点').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥42.50').length).toBeGreaterThan(0)
    // 没有加起来的那个数。
    expect(screen.queryAllByText(/1,?242\.50/)).toHaveLength(0)
    expect(screen.queryAllByText(/¥1,?242\.50/)).toHaveLength(0)
  })

  it('Provider 没有报额度的时候给空状态', async () => {
    const client = mockAdminClient({
      GetBalance: () => create(GetBalanceResponseSchema, { quotas: [] }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('Provider 没有报额度。')).toBeInTheDocument()
  })
})
