import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AddProviderRequestSchema,
  DeleteProviderRequestSchema,
  ListProviderKindsRequestSchema,
  ListUpstreamsRequestSchema,
  SetUpstreamEnabledRequestSchema,
  UpdateProviderRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { systemKeys } from '@/features/overview/api'
import { assertOk, describeError } from '@/lib/errors'

export const upstreamKeys = {
  all: ['upstreams'] as const,
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
    queryKey: [...upstreamKeys.all, 'kinds'],
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

/** 改一个 Provider 的别名。 */
export function useUpdateProvider() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; alias?: string; enabled?: boolean }) => {
      const result = await client.updateProvider(
        create(UpdateProviderRequestSchema, {
          id: input.id,
          alias: input.alias ?? '',
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
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
