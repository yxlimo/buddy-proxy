import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { ListUsageEventsRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

export const usageKeys = {
  events: (upstreamId: string, model: string, limit: number, beforeId: string) =>
    ['usage', 'events', upstreamId, model, limit, beforeId] as const,
}

/**
 * 用量明细。
 *
 * 契约现在有 before_id 游标了（只返回 id 比它小的），后端还没实现，先把
 * 接口留着：现在一次拉 limit 条，在这一段里翻页。
 */
export function useUsageEvents(input: {
  upstreamId: string
  model: string
  limit: number
  beforeId?: bigint
}) {
  const client = useAdminClient()
  const beforeId = input.beforeId ?? 0n
  return useQuery({
    queryKey: usageKeys.events(
      input.upstreamId,
      input.model,
      input.limit,
      beforeId.toString()
    ),
    queryFn: () =>
      client.listUsageEvents(
        create(ListUsageEventsRequestSchema, {
          limit: input.limit,
          upstreamId: input.upstreamId,
          model: input.model,
          beforeId,
        })
      ),
  })
}
