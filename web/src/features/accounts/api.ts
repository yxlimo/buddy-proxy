import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListCredentialsRequestSchema,
  SetProviderKeysRequestSchema,
  TestCredentialRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { accountKeys } from '@/features/accounts/keys'
import { upstreamKeys } from '@/features/upstreams/api'
import { assertOk, describeError } from '@/lib/errors'

export { accountKeys }

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
 * 写一个账号的 API Key 列表。
 *
 * key 挂在账号上（一个账号一份凭据），所以这里带的是账号行 id。契约里的字段名
 * 还叫 upstream_id —— 账号就是 provider 表里那一行，语义是同一处。
 */
export function useSetProviderKeys() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { accountId: string; keys: string[] }) => {
      const result = await client.setProviderKeys(
        create(SetProviderKeysRequestSchema, {
          upstreamId: input.accountId,
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}
