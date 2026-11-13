import { describe, expect, it } from 'vitest'
import { credentialKindLabel } from '@/lib/credential-kind'

/**
 * 凭据类型只说三种：登录会话、推理 Key、额度 Cookie。
 *
 * 这三条是界面契约：平台页的凭据表与总览页的凭据行都按这里的说法显示。
 */
describe('凭据类型的说法', () => {
  it('协议值换成中文', () => {
    expect(credentialKindLabel('session')).toBe('登录会话')
    expect(credentialKindLabel('api_key')).toBe('推理 Key')
    expect(credentialKindLabel('cookie')).toBe('额度 Cookie')
  })

  it('没登记的值原样返回，不自创名字', () => {
    expect(credentialKindLabel('plan_key')).toBe('plan_key')
    expect(credentialKindLabel('whatever')).toBe('whatever')
  })

  it('空值给空串', () => {
    expect(credentialKindLabel('')).toBe('')
    expect(credentialKindLabel(undefined)).toBe('')
  })
})
