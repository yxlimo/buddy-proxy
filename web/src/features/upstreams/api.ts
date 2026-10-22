import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListUpstreamsRequestSchema,
  SetUpstreamEnabledRequestSchema,
  type ListUpstreamsResponse,
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
 * 开/关一个上游。改了要重启网关才生效，所以回包里带 pending_restart。
 *
 * 服务端用 ok:false 表达「不认识这个上游」，这里翻成异常，界面按失败处理。
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
    // 先把开关拨过去，等服务端回来再改回来 —— 点下去要立刻有反应。
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: upstreamKeys.all })
      const previous = queryClient.getQueryData<ListUpstreamsResponse>(
        upstreamKeys.all
      )
      queryClient.setQueryData<ListUpstreamsResponse>(
        upstreamKeys.all,
        (old) =>
          old
            ? {
                ...old,
                upstreams: old.upstreams.map((upstream) =>
                  upstream.id === input.upstreamId
                    ? { ...upstream, enabled: input.enabled }
                    : upstream
                ),
              }
            : old
      )
      return { previous }
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(upstreamKeys.all, context.previous)
      }
      toast.error(describeError(error))
    },
    onSuccess: (result, input) => {
      toast.success(
        result.message ||
          (input.enabled ? '已打开，重启后生效' : '已关掉，重启后生效')
      )
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.all })
      void queryClient.invalidateQueries({ queryKey: systemKeys.status })
    },
  })
}
