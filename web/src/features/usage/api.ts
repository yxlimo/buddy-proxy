import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { ListUsageEventsRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

const usageKeys = {
  events: (
    upstreamId: string,
    model: string,
    limit: number,
    beforeId: string,
    window: string
  ) => ['usage', 'events', upstreamId, model, limit, beforeId, window] as const,
}

/**
 * 用量明细。
 *
 * 时间窗跟合计那页是同一个：today = 本地零点起。
 */
export function useUsageEvents(input: {
  upstreamId: string
  model: string
  limit: number
  beforeId?: bigint
  window?: string
}) {
  const client = useAdminClient()
  const beforeId = input.beforeId ?? 0n
  const window = input.window ?? ''
  return useQuery({
    queryKey: usageKeys.events(
      input.upstreamId,
      input.model,
      input.limit,
      beforeId.toString(),
      window
    ),
    queryFn: () =>
      client.listUsageEvents(
        create(ListUsageEventsRequestSchema, {
          limit: input.limit,
          upstreamId: input.upstreamId,
          model: input.model,
          beforeId,
          window,
        })
      ),
  })
}
