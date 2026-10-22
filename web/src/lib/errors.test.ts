import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it } from 'vitest'
import { ApiFailure, assertOk, describeError, isAuthError } from '@/lib/errors'

describe('把错误翻成人话', () => {
  it('鉴权没过要说清楚是令牌的问题', () => {
    const error = new ConnectError('面板令牌不对。', Code.Unauthenticated)
    const text = describeError(error)
    expect(text).toContain('鉴权没过')
    expect(text).toContain('面板令牌不对。')
  })

  it('网关连不上、没实现、参数不合法各说各的', () => {
    expect(describeError(new ConnectError('连不上', Code.Unavailable))).toContain(
      '网关连不上'
    )
    expect(
      describeError(new ConnectError('还没做', Code.Unimplemented))
    ).toContain('还没实现')
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

describe('assertOk', () => {
  it('ok 为真就什么都不做', () => {
    expect(() => assertOk({ ok: true, message: '好了' }, '没保存成')).not.toThrow()
  })

  it('ok 为假就抛异常，消息用服务端给的', () => {
    expect(() =>
      assertOk({ ok: false, message: '不认识的上游：xxx' }, '没改成')
    ).toThrow('不认识的上游：xxx')
  })

  it('服务端没给消息就用兜底的那句', () => {
    expect(() => assertOk({ ok: false }, '没改成')).toThrow('没改成')
  })
})

describe('isAuthError', () => {
  it('401 算鉴权失败', () => {
    expect(isAuthError(new ConnectError('x', Code.Unauthenticated))).toBe(true)
  })

  it('403 不算：令牌没问题，只是不许', () => {
    expect(isAuthError(new ConnectError('x', Code.PermissionDenied))).toBe(false)
  })

  it('别的错误不算', () => {
    expect(isAuthError(new ConnectError('x', Code.Internal))).toBe(false)
    expect(isAuthError(new Error('x'))).toBe(false)
  })
})
