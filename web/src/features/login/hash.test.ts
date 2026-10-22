import { describe, expect, it } from 'vitest'
import { readLoginId, writeLoginId } from '@/features/login/hash'

/**
 * 没走完的登录放在 URL 的 hash 里。
 *
 * 面板刷新之后要接得上：hash 里的 login_id 还在，就能继续问进度。
 * 路由用的是 history，hash 路由没用，所以不打架。
 */
describe('hash 里的 login_id', () => {
  it('从 hash 里读出来', () => {
    expect(readLoginId('#login=abc-123')).toBe('abc-123')
    expect(readLoginId('login=abc-123')).toBe('abc-123')
    expect(readLoginId('#')).toBe('')
    expect(readLoginId('')).toBe('')
    expect(readLoginId('#other=1')).toBe('')
  })

  it('写进去之后读得回来', () => {
    const before = window.location.href
    writeLoginId('abc-123')
    expect(readLoginId(window.location.hash)).toBe('abc-123')
    expect(window.location.hash).toContain('login=abc-123')

    // 清掉。
    writeLoginId('')
    expect(readLoginId(window.location.hash)).toBe('')
    window.history.replaceState(null, '', before)
  })

  it('不往 URL 里放管理令牌', () => {
    const before = window.location.href
    writeLoginId('abc-123')
    expect(window.location.href).not.toContain('token')
    window.history.replaceState(null, '', before)
  })
})
