import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BalanceLotSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { BalanceLotsTable } from '@/features/balance/balance-lots'

// 平台的「永不过期」标记：2099-12-31。
// 契约里的时间戳是 Unix 毫秒。
const NEVER = BigInt(Date.UTC(2099, 11, 31))
const SOON = BigInt(Date.UTC(2030, 0, 15))
const PAST = BigInt(Date.UTC(2020, 0, 1))

/**
 * 余额里的每一笔：钱。
 *
 * 跟积分分开：钱就是钱，写 ¥。
 */
describe('余额批次', () => {
  it('把每一笔赠金列出来', () => {
    render(
      <BalanceLotsTable
        lots={[
          create(BalanceLotSchema, {
            id: 'lot-1',
            sourceLabel: '新人活动',
            remainingCny: 12.5,
            expiresAt: SOON,
            status: 'active',
          }),
        ]}
      />
    )

    expect(screen.getByText('lot-1')).toBeInTheDocument()
    expect(screen.getByText('新人活动')).toBeInTheDocument()
    expect(screen.getByText('¥12.50')).toBeInTheDocument()
    const row = screen.getByText('lot-1').closest('tr')
    expect(row?.textContent).toContain('2030')
  })

  it('2099-12-31 原样显示，倒计时那一列给「—」', () => {
    render(
      <BalanceLotsTable
        lots={[
          create(BalanceLotSchema, {
            id: 'lot-never',
            sourceLabel: '永久赠金',
            remainingCny: 100,
            expiresAt: NEVER,
            status: 'active',
          }),
        ]}
      />
    )

    // 日期原样透出，不翻译成「永不过期」
    const row = screen.getByText('lot-never').closest('tr')
    expect(row?.textContent).toContain('2099')
    expect(row?.textContent).toContain('12')
    expect(row?.textContent).toContain('31')
    expect(row?.textContent).not.toContain('永不过期')
    expect(row?.textContent).toContain('—')
  })

  it('已经到期的批次标出来', () => {
    render(
      <BalanceLotsTable
        lots={[
          create(BalanceLotSchema, {
            id: 'lot-past',
            remainingCny: 1,
            expiresAt: PAST,
            status: 'expired',
          }),
        ]}
      />
    )

    expect(screen.getByText('已到期')).toBeInTheDocument()
  })

  it('没有批次的时候给空状态', () => {
    render(<BalanceLotsTable lots={[]} />)
    expect(screen.getByText('没有余额批次')).toBeInTheDocument()
  })
})
