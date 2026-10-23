import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CreditLotSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { CreditLotsTable } from '@/features/balance/credit-lots'

// 平台的「永不过期」标记：2099-12-31。
// 契约里的时间戳是 Unix 毫秒。
const NEVER = BigInt(Date.UTC(2099, 11, 31))
const SOON = BigInt(Date.UTC(2030, 0, 15))
const PAST = BigInt(Date.UTC(2020, 0, 1))

/**
 * 积分批次：点数。
 *
 * 积分不是钱：表里没有 ¥，也不跟余额加在一起。
 */
describe('积分批次', () => {
  it('把每一笔积分列出来（点数，不是钱）', () => {
    render(
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-1',
            sourceLabel: '新人活动',
            remaining: 1250,
            expiresAt: SOON,
            status: 'active',
          }),
        ]}
      />
    )

    expect(screen.getByText('lot-1')).toBeInTheDocument()
    expect(screen.getByText('新人活动')).toBeInTheDocument()
    // 点数就是点数，不写成钱。
    expect(screen.getByText('1,250 点')).toBeInTheDocument()
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument()
    const row = screen.getByText('lot-1').closest('tr')
    expect(row?.textContent).toContain('2030')
  })

  it('2099-12-31 原样显示，倒计时那一列给「—」', () => {
    render(
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-never',
            sourceLabel: '永久赠金',
            remaining: 100,
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
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-past',
            remaining: 1,
            expiresAt: PAST,
            status: 'expired',
          }),
        ]}
      />
    )

    expect(screen.getByText('已到期')).toBeInTheDocument()
  })

  it('没有批次的时候给空状态', () => {
    render(<CreditLotsTable lots={[]} />)
    expect(screen.getByText('没有积分批次')).toBeInTheDocument()
  })
})
