import { Code, ConnectError } from '@connectrpc/connect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_ERROR_TEXT } from '@/lib/admin-errors'
import { ApiFailure, assertOk, describeError, isAuthError } from '@/lib/errors'

/** 一次带机器码的失败（机器码在响应头上，和其他头一样）。 */
function withCode(code: string, message = '已经有这个平台了'): ConnectError {
  return new ConnectError(message, Code.AlreadyExists, {
    'buddy-error': code,
  })
}

describe('把错误翻成人话', () => {
  it('鉴权未通过时要说明是访问令牌的问题', () => {
    const error = new ConnectError('面板令牌不对。', Code.Unauthenticated)
    const text = describeError(error)
    expect(text).toContain('鉴权未通过')
    expect(text).toContain('面板令牌不对。')
  })

  it('网关不可用、未实现、参数不合法各说各的', () => {
    expect(describeError(new ConnectError('连不上', Code.Unavailable))).toContain(
      '网关不可用'
    )
    expect(
      describeError(new ConnectError('还没做', Code.Unimplemented))
    ).toContain('未实现该接口')
    expect(
      describeError(new ConnectError('键不对', Code.InvalidArgument))
    ).toContain('参数不合法')
  })

  it('业务上的失败（ok:false）原样给用户看', () => {
    expect(describeError(new ApiFailure('模型至少要有一个上游'))).toBe(
      '模型至少要有一个上游'
    )
  })

  it('不是 Error 的东西也能说点什么', () => {
    expect(describeError('就是坏了')).toBe('就是坏了')
  })
})

describe('响应头上有机器码时按码给文案', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('认得的码：给码表那句话，不带服务端的事实句', () => {
    const text = describeError(withCode('PLATFORM_ALREADY_EXISTS'))
    expect(text).toBe(ADMIN_ERROR_TEXT.PLATFORM_ALREADY_EXISTS)
    expect(text).not.toContain('已经有这个平台了')
    expect(text).not.toContain('资源已存在')
  })

  it('认不得的码：原样给机器码，并告一声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = describeError(withCode('SOMETHING_NEW'))
    expect(text).toBe('SOMETHING_NEW')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('没有那个头：仍按 Connect 的 Code 兜底', () => {
    const error = new ConnectError('键不对', Code.InvalidArgument)
    expect(describeError(error)).toContain('参数不合法：键不对')
  })

  it('原型键不吃文案：constructor 走「不认得」那一支', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = describeError(withCode('constructor'))
    expect(text).toBe('constructor')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('assertOk', () => {
  it('ok 为真就什么都不做', () => {
    expect(() => assertOk({ ok: true, message: '好了' }, '保存失败')).not.toThrow()
  })

  it('ok 为假就抛异常，消息用服务端给的', () => {
    expect(() =>
      assertOk({ ok: false, message: '不认识的上游：xxx' }, '保存失败')
    ).toThrow('不认识的上游：xxx')
  })

  it('服务端没给消息就用兜底的那句', () => {
    expect(() => assertOk({ ok: false }, '保存失败')).toThrow('保存失败')
  })
})

describe('isAuthError', () => {
  it('401 算鉴权失败', () => {
    expect(isAuthError(new ConnectError('x', Code.Unauthenticated))).toBe(true)
  })

  it('403 不计为鉴权失败：访问令牌有效，仅权限不足', () => {
    expect(isAuthError(new ConnectError('x', Code.PermissionDenied))).toBe(false)
  })

  it('别的错误不算', () => {
    expect(isAuthError(new ConnectError('x', Code.Internal))).toBe(false)
    expect(isAuthError(new Error('x'))).toBe(false)
  })
})
