import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListUpstreamsRequestSchema,
  SetUpstreamEnabledRequestSchema,
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
