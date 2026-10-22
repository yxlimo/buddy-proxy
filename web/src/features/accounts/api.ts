import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListAccountsRequestSchema,
  ListCredentialsRequestSchema,
  RefreshCredentialRequestSchema,
  TestCredentialRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
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

/** 强制刷新一条凭据。 */
export function useRefreshCredential() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { credentialId: string }) => {
      const result = await client.refreshCredential(
        create(RefreshCredentialRequestSchema, {
          credentialId: input.credentialId,
        })
      )
      assertOk(result, '刷新失败')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || `刷新完成（第 ${result.generation} 代）`)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
    },
  })
}
