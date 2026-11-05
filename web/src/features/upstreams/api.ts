import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AddAccountRequestSchema,
  DeleteAccountRequestSchema,
  ListUpstreamsRequestSchema,
  SetAccountEnabledRequestSchema,
  SetPlatformPolicyRequestSchema,
  UpdateProviderRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { ProviderPolicy } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { assertOk, describeError } from '@/lib/errors'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'

/** 平台列表的查询键。键本身在 `lib/query-keys.ts` 里，见那份的说明。 */
export const upstreamKeys = queryKeys.upstreams

/**
 * 平台列表。
 *
 * 一行一个平台：表里的每一行（播种的模拟客户端与自建的开放平台）加上它名下的
 * 账号。平台改得了名字、删得掉，改不了 id。
 *
 * refetchOnMount: false 给旁观者用：已经在别处拿过列表的组件只想读一下平台的
 * kind，不该再发一次请求。
 */
export function useUpstreams(options?: { refetchOnMount?: boolean }) {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.upstreams.all,
    queryFn: () => client.listUpstreams(create(ListUpstreamsRequestSchema)),
    ...options,
  })
}

/**
 * 开/关一个账号。
 *
 * 开关是热的：面板改完立刻生效，不用重启。所以这里不存本地状态，一切以服务端
 * 的答复为准（重取列表时 Account.enabled 就是现在的值）。
 */
export function useSetAccountEnabled() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { accountId: string; enabled: boolean }) => {
      const result = await client.setAccountEnabled(
        create(SetAccountEnabledRequestSchema, {
          accountId: input.accountId,
          enabled: input.enabled,
        })
      )
      assertOk(result, '没改成')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已保存，已经生效')
    },
    onSettled: () => {
      // 一个账号的开关：账号那份答复、平台那份（带账号）、总览、额度都变了。
      invalidateServerData(queryClient, 'accounts')
    },
  })
}

/**
 * 在一个平台下加一个账号。
 *
 * 平台是模板，加不了：能加的只有账号。别名可以不给，服务端会起一个。
 */
export function useAddAccount() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { platform: string; alias?: string }) => {
      const result = await client.addAccount(
        create(AddAccountRequestSchema, {
          platform: input.platform,
          alias: input.alias ?? '',
        })
      )
      assertOk(result, '没加上')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '加上了')
    },
    onSettled: () => {
      invalidateServerData(queryClient, 'accounts')
    },
  })
}

/**
 * 注销一个账号：删掉这一行，连同它名下的凭据。
 *
 * 平台是模板，删不掉；删的只能是账号。
 */
export function useDeleteAccount() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const result = await client.deleteAccount(
        create(DeleteAccountRequestSchema, { id: input.id })
      )
      assertOk(result, '没删掉')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '删掉了')
    },
    onSettled: () => {
      invalidateServerData(queryClient, 'accounts')
    },
  })
}

/**
 * 改一个平台的生效策略。
 *
 * 策略是平台的事：它说的是「这个平台下的几个账号怎么选」。所以改策略只带平台
 * id，不碰账号行。
 */
export function useSetPlatformPolicy() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      platform: string
      policy: ProviderPolicy
    }) => {
      const result = await client.setPlatformPolicy(
        create(SetPlatformPolicyRequestSchema, {
          platform: input.platform,
          policy: input.policy,
        })
      )
      assertOk(result, '没改成')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '策略改好了')
    },
    onSettled: () => {
      // 策略是平台那一行上的字段：平台那份答复变了。
      invalidateServerData(queryClient, 'platforms')
    },
  })
}

/**
 * 改一个账号的别名。
 *
 * 契约里「没说的字段就是不改」，所以只有带了的字段才进请求体。开关不在这里：
 * 开关走 useSetAccountEnabled（setAccountEnabled 有自己的方法）。
 */
export function useUpdateProvider() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; alias?: string; weight?: number }) => {
      const result = await client.updateProvider(
        create(UpdateProviderRequestSchema, {
          id: input.id,
          alias: input.alias ?? '',
          // 不给就是不改。
          weight: input.weight,
        })
      )
      assertOk(result, '没改成')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '改好了')
    },
    onSettled: () => {
      invalidateServerData(queryClient, 'accounts')
    },
  })
}
