import { describe, expect, it } from 'vitest'
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatMillis,
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
