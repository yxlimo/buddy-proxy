import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BeginLoginRequestSchema,
  CancelLoginRequestSchema,
  ExchangeLoginCodeRequestSchema,
  GetLoginStatusRequestSchema,
  ImportLoginTokenRequestSchema,
  LoginWithPasswordRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { accountKeys } from '@/features/accounts/api'
import { assertOk, describeError, humanMessage } from '@/lib/errors'

/**
 * 错误怎么给人看。
 *
 * 后端的话是「中文（机器码）」，机器码是给日志看的，不甩给人。
 */
export function loginErrorText(error: unknown): string {
  return humanMessage(describeError(error))
}

/** 轮询的间隔：3 秒。后端在后台轮上游，面板只是问进度。 */
export const LOGIN_POLL_MS = 3000

export const loginKeys = {
  status: (loginId: string) => ['login', loginId] as const,
}

/** 能轮询的登录方式：授权链接型。密码与 token 型是用户自己填的。 */
function pollable(method: string): boolean {
  return method === 'device' || method === 'browser'
}

/**
 * 这次登录到哪一步了。
 *
 * 只有「授权链接型」才轮询，而且只在还没结束的时候轮：成了、败了、过期了
 * 都不再问。
 */
export function useLoginStatus(loginId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: loginKeys.status(loginId),
    queryFn: async () => {
      const result = await client.getLoginStatus(
        create(GetLoginStatusRequestSchema, { loginId })
      )
      assertOk(result, '查不到这次登录')
      return result
    },
    enabled: loginId !== '',
    refetchInterval: (query) => {
      const session = query.state.data?.session
      if (!session) return false
      if (session.status !== 'pending') return false
      return pollable(session.method) ? LOGIN_POLL_MS : false
    },
  })
}

/** 开始一次登录。 */
export function useBeginLogin() {
  const client = useAdminClient()
  return useMutation({
    mutationFn: async (input: {
      upstreamId: string
      accountId?: string
    }) => {
      const result = await client.beginLogin(
        create(BeginLoginRequestSchema, {
          upstreamId: input.upstreamId,
          accountId: input.accountId ?? '',
        })
      )
      assertOk(result, '没能开始登录')
      return result.session
    },
    onError: (error) => {
      toast.error(loginErrorText(error))
    },
  })
}

/** 不等了。 */
export function useCancelLogin() {
  const client = useAdminClient()
  return useMutation({
    mutationFn: async (loginId: string) => {
      const result = await client.cancelLogin(
        create(CancelLoginRequestSchema, { loginId })
      )
      assertOk(result, '没取消成')
      return result
    },
    onError: (error) => {
      toast.error(loginErrorText(error))
    },
  })
}

/** 账号密码登录。 */
export function useLoginWithPassword() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      upstreamId: string
      accountId: string
      username: string
      password: string
      remember: boolean
    }) => {
      const result = await client.loginWithPassword(
        create(LoginWithPasswordRequestSchema, {
          upstreamId: input.upstreamId,
          accountId: input.accountId,
          username: input.username,
          password: input.password,
          remember: input.remember,
        })
      )
      assertOk(result, '登录没成功')
      return result
    },
    onError: (error) => {
      toast.error(loginErrorText(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '登录好了')
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}

/** 把浏览器里拿到的授权码换成凭据（intern-ai）。 */
export function useExchangeLoginCode() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      upstreamId: string
      accountId: string
      code: string
    }) => {
      const result = await client.exchangeLoginCode(
        create(ExchangeLoginCodeRequestSchema, {
          upstreamId: input.upstreamId,
          accountId: input.accountId,
          code: input.code,
        })
      )
      assertOk(result, '换码没成功')
      return result
    },
    onError: (error) => {
      toast.error(loginErrorText(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '换好了')
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}

/** 把浏览器里拿到的 token 贴回来（intern-ai）。 */
export function useImportLoginToken() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      upstreamId: string
      accountId: string
      token: string
    }) => {
      const result = await client.importLoginToken(
        create(ImportLoginTokenRequestSchema, {
          upstreamId: input.upstreamId,
          accountId: input.accountId,
          token: input.token,
        })
      )
      assertOk(result, '导入没成功')
      return result
    },
    onError: (error) => {
      toast.error(loginErrorText(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '导入好了')
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}

/** 后端给的话是「中文（机器码）」，机器码不给人看。 */
export { humanMessage }
