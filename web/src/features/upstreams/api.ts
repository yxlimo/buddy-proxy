import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AddProviderRequestSchema,
  DeleteProviderRequestSchema,
  ListProviderKindsRequestSchema,
  ListUpstreamsRequestSchema,
  SetProviderPolicyRequestSchema,
  SetUpstreamEnabledRequestSchema,
  UpdateProviderRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { ProviderPolicy } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { systemKeys } from '@/features/overview/api'
import { assertOk, describeError } from '@/lib/errors'

export const upstreamKeys = {
  all: ['upstreams'] as const,
  /**
   * 种类与它支持的策略是一份注册表，不随上游列表变。
   *
   * 键跟上游列表不共享前缀：失效上游列表的时候（前缀匹配）不要连带把
   * 它也重取一遍 —— 改一次策略不该多发一次 ListProviderKinds。
   */
  kinds: ['provider-kinds'] as const,
}

export function useUpstreams() {
  const client = useAdminClient()
  return useQuery({
    queryKey: upstreamKeys.all,
    queryFn: () => client.listUpstreams(create(ListUpstreamsRequestSchema)),
  })
}

/**
 * 开/关一个上游。
 *
 * 开关是热的：面板改完立刻生效，不用重启。所以这里不存本地状态，
 * 一切以服务端的答复为准（Upstream.enabled 就是现在的值）。
 */
export function useSetUpstreamEnabled() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { upstreamId: string; enabled: boolean }) => {
      const result = await client.setUpstreamEnabled(
        create(SetUpstreamEnabledRequestSchema, {
          upstreamId: input.upstreamId,
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
      void queryClient.invalidateQueries({ queryKey: systemKeys.status })
    },
  })
}

/** 面板上能选的 Provider 类型。面板不问后端有哪些类，它问。 */
export function useProviderKinds() {
  const client = useAdminClient()
  return useQuery({
    queryKey: upstreamKeys.kinds,
    queryFn: () =>
      client.listProviderKinds(create(ListProviderKindsRequestSchema)),
  })
}

/** 加一个 Provider。同一类可以加很多个，它们各有各的凭据。 */
export function useAddProvider() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      kind: string
      alias?: string
      region?: string
    }) => {
      const result = await client.addProvider(
        create(AddProviderRequestSchema, {
          id: input.id,
          kind: input.kind,
          alias: input.alias ?? '',
          region: input.region ?? '',
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}

/**
 * 改一个 Provider 的别名。
 *
 * 契约里「没说的字段就是不改」，所以只有带了的字段才进请求体。
 * 生效策略不在这里：策略有自己一个方法（见 useSetProviderPolicy）。
 * 开关也不在这里：开关走 useSetUpstreamEnabled。
 */
export function useUpdateProvider() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; alias?: string }) => {
      const result = await client.updateProvider(
        create(UpdateProviderRequestSchema, {
          id: input.id,
          alias: input.alias ?? '',
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}

/**
 * 改一个上游的生效策略。
 *
 * 策略自己一个方法：混在 UpdateProvider 里，改策略会顺手把别名也改掉
 * （alias 在契约里是普通 string，没有「没给」这一说）。
 */
export function useSetProviderPolicy() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      upstreamId: string
      policy: ProviderPolicy
    }) => {
      const result = await client.setProviderPolicy(
        create(SetProviderPolicyRequestSchema, {
          upstreamId: input.upstreamId,
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}

/** 删一个 Provider。 */
export function useDeleteProvider() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const result = await client.deleteProvider(
        create(DeleteProviderRequestSchema, { id: input.id })
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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
    },
  })
}
