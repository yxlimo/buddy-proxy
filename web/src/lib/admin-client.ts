import { type Interceptor, Code, ConnectError, createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { AdminService } from '@/gen/buddy/admin/v1/admin_pb'
import { getEffectiveToken } from '@/features/auth/token-store'

// 面板是网关自己托管的静态文件，接口也在同一个源上，所以 baseUrl 用相对
// 地址就够了。开发时 vite 把这个前缀代理到网关（见 vite.config.ts）。
const baseUrl = import.meta.env.VITE_ADMIN_API_BASE ?? ''

/**
 * 鉴权走 Authorization 头。契约里没有这个字段 —— 鉴权不是消息的一部分。
 */
const authInterceptor: Interceptor = (next) => async (req) => {
  const token = getEffectiveToken()
  if (token) {
    req.header.set('Authorization', `Bearer ${token}`)
  }
  return await next(req)
}

const transport = createConnectTransport({
  baseUrl,
  interceptors: [authInterceptor],
})

export const adminClient = createClient(AdminService, transport)

export type AdminClient = typeof adminClient

export { Code, ConnectError }
