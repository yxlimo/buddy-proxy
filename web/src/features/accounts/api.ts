import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListAccountsRequestSchema,
  ListCredentialsRequestSchema,
  LogoutAccountRequestSchema,
  SetProviderKeysRequestSchema,
  TestCredentialRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { upstreamKeys } from '@/features/upstreams/api'
import { assertOk, describeError } from '@/lib/errors'

export const accountKeys = {
  all: ['accounts'] as const,
  credentials: (accountId: string) =>
    ['accounts', accountId, 'credentials'] as const,
}

export function useAccounts() {
  const client = useAdminClient()
  return useQuery({
    queryKey: accountKeys.all,
    queryFn: () => client.listAccounts(create(ListAccountsRequestSchema)),
  })
}

/**
 * 某个账号名下的凭据。
 *
 * 空串表示「全部账号的凭据」，但页面没选账号时不该发这个请求 —— 所以
 * enabled 只在真的选了账号时才为真。
 */
export function useCredentials(accountId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: accountKeys.credentials(accountId),
    queryFn: () =>
      client.listCredentials(create(ListCredentialsRequestSchema, { accountId })),
    enabled: accountId !== '',
  })
}

/** 试一个凭据还能不能用。 */
export function useTestCredential() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { credentialId: string }) => {
      const result = await client.testCredential(
        create(TestCredentialRequestSchema, {
          credentialId: input.credentialId,
        })
      )
      assertOk(result, '这条凭据不能用')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '这条凭据还能用')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}

/**
 * 写一个 Provider 的 API Key 列表。
 *
 * MiniMax 开放平台一把 key 一个租户，所以这里传的是列表。
 */
export function useSetProviderKeys() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { upstreamId: string; keys: string[] }) => {
      const result = await client.setProviderKeys(
        create(SetProviderKeysRequestSchema, {
          upstreamId: input.upstreamId,
          keys: input.keys,
        })
      )
      assertOk(result, '写入失败')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已写入')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}

/**
 * 注销一个账号：把它名下的凭据全删掉。
 *
 * 删完这个账号就回到「没有凭据」的状态，面板上「登录」按钮重新出现。
 */
export function useLogoutAccount() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { accountId: string }) => {
      const result = await client.logoutAccount(
        create(LogoutAccountRequestSchema, { accountId: input.accountId })
      )
      assertOk(result, '没注销掉')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已注销')
    },
    onSettled: () => {
      // ['accounts'] 是所有账号与凭据查询的前缀，所以这一句把凭据列表也刷了。
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
      // 上游那行的凭据摘要也是后端算的，跟着变。
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}
