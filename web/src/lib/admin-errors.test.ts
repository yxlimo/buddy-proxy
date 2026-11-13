import { describe, expect, it } from 'vitest'
import {
  ADMIN_ERROR_TEXT,
  BUDDY_ERROR_HEADER,
  adminErrorText,
  unknownAdminErrorText,
} from '@/lib/admin-errors'

describe('机器码 → 面板文案', () => {
  it('每个码都有文案，没有空串', () => {
    const codes = Object.keys(ADMIN_ERROR_TEXT)
    expect(codes.length).toBeGreaterThan(0)
    for (const code of codes) {
      const text = ADMIN_ERROR_TEXT[code]
      expect(typeof text, code).toBe('string')
      expect(text.trim(), code).not.toBe('')
    }
  })

  it('没有两个码共用一句话', () => {
    // 「这个平台不存在」两个码共用：一个是改平台时那个平台没了，一个是加账号时
    // 指的平台没了 —— 对看面板的人是同一件事，没必要为不同而不同。其余码一句
    // 一码：两句一样就说明两个码分不清原因。
    const shared = new Set([
      'ACCOUNT_PLATFORM_NOT_FOUND',
      'PLATFORM_NOT_FOUND',
    ])
    const seen = new Map<string, string>()
    for (const [code, text] of Object.entries(ADMIN_ERROR_TEXT)) {
      const known = seen.get(text)
      if (known) {
        expect([known, code].every((item) => shared.has(item)), code).toBe(true)
        continue
      }
      seen.set(text, code)
    }
    expect(Object.keys(ADMIN_ERROR_TEXT).length).toBe(
      seen.size + shared.size - 1
    )
  })

  it('文案只讲哪里错：没有祈使句，也不长', () => {
    // 报错都是少见情况：那句话只用来说清现在怎么了。带指引的话（「填一个再
    // 保存」）在面板上已经被提前置灰挡掉了，写回来就是一句没用的话。
    // 「请求」里的那个请不算：「请求里没有模型」是在说事实。
    const imperatives = [
      /请(?!求)/,
      /填上/,
      /填一个/,
      /补上/,
      /换一个/,
      /换个/,
      /刷新/,
      /稍后重试/,
      /再试/,
      /选一个/,
      /改好/,
      /改个/,
    ]
    for (const [code, text] of Object.entries(ADMIN_ERROR_TEXT)) {
      for (const word of imperatives) {
        expect(word.test(text), `${code}: ${text}`).toBe(false)
      }
      // 一条不超过 20 汉字（ASCII 的网址、id 不计）。
      const han = [...text].filter((char) => /[\u4e00-\u9fff]/.test(char))
      expect(han.length, `${code}: ${text}`).toBeLessThanOrEqual(20)
    }
  })

  it('原型键不算码：取到的是 undefined，不是原型上的东西', () => {
    expect(adminErrorText('constructor')).toBeUndefined()
    expect(adminErrorText('toString')).toBeUndefined()
    expect(adminErrorText('__proto__')).toBeUndefined()
  })

  it('认得的码取回自己那句话', () => {
    expect(adminErrorText('PLATFORM_ALREADY_EXISTS')).toBe(
      ADMIN_ERROR_TEXT.PLATFORM_ALREADY_EXISTS
    )
  })

  it('认不得的码原样返回机器码', () => {
    expect(unknownAdminErrorText('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })

  it('响应头名字是小写的 buddy-error', () => {
    expect(BUDDY_ERROR_HEADER).toBe('buddy-error')
  })
})
