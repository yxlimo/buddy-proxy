import { describe, expect, it } from 'vitest'
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatMillis,
  formatMoney,
  formatPoints,
  formatUptime,
  isFarFuture,
  remainingDays,
} from '@/lib/format'

/**
 * 契约里的时间戳是 Unix 毫秒（网关那边是 Date.now()），只有名字里带
 * _sec 的两个是秒。这组用例把单位钉死，别让谁改。
 */
describe('时间的单位', () => {
  it('时间戳按毫秒算', () => {
    const ms = BigInt(Date.UTC(2026, 9, 22, 12, 0, 0))
    expect(formatDate(ms)).toContain('2026')
    expect(formatDate(ms)).toContain('10')
    expect(formatDate(ms)).not.toContain('58777')
    expect(formatDateTime(ms)).toContain('2026')
  })

  it('运行时长是秒', () => {
    expect(formatUptime(7200n)).toBe('2 小时 0 分钟')
    expect(formatUptime(90n)).toBe('1 分钟')
  })

  it('延时按毫秒算', () => {
    expect(formatMillis(500n)).toBe('500 毫秒')
    expect(formatMillis(1500n)).toBe('1.5 秒')
  })

  it('2099-12-31 是「永不过期」，倒计时不给天数', () => {
    const never = BigInt(Date.UTC(2099, 11, 31))
    expect(isFarFuture(never)).toBe(true)
    expect(isFarFuture(BigInt(Date.UTC(2030, 0, 15)))).toBe(false)
    expect(remainingDays(BigInt(Date.UTC(2020, 0, 1)))).toBe(0)
  })

  it('没有值的时候给占位符', () => {
    expect(formatDate(0n)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatUptime(0n)).toBe('—')
    expect(formatCount(undefined)).toBe('0')
  })
})

/**
 * 钱和点数是两种单位：钱带 ¥，点数不带。
 *
 * 积分不是钱，界面上不能把点数写成 ¥，也不能拿点数去加余额。
 */
describe('钱和点数', () => {
  it('人民币写 ¥，别的币种把币种写出来', () => {
    expect(formatMoney(42.5, 'CNY')).toBe('¥42.50')
    expect(formatMoney(42.5, '')).toBe('¥42.50')
    expect(formatMoney(42.5, 'USD')).toBe('USD 42.50')
    // 不猜汇率，也不换算。
    expect(formatMoney(42.5, 'USD')).not.toContain('¥')
  })

  it('点数就是点数，不带 ¥', () => {
    expect(formatPoints(1200)).toBe('1,200')
    expect(formatPoints(12.5)).toBe('12.50')
    expect(formatPoints(undefined)).toBe('0')
    expect(formatPoints(1200)).not.toContain('¥')
  })
})
