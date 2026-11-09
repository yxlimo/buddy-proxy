import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import {
  GetSystemStatusRequestSchema,
  GetUsageSummaryRequestSchema,
  type GetUsageSummaryRequest,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { queryKeys } from '@/lib/query-keys'

/** 总览那份状态的查询键。键本身在 `lib/query-keys.ts` 里。 */
export const systemKeys = queryKeys.system

export function useSystemStatus() {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.system.status,
    queryFn: () => client.getSystemStatus(create(GetSystemStatusRequestSchema)),
  })
}

export function useUsageSummary(input: {
  upstreamId: string
  window: string
}) {
  const client = useAdminClient()
  const request = create(GetUsageSummaryRequestSchema, {
    upstreamId: input.upstreamId,
    window: input.window,
  })
  return useQuery({
    queryKey: queryKeys.system.usage(input.upstreamId, input.window),
    queryFn: () => client.getUsageSummary(request),
  })
}

export type { GetUsageSummaryRequest }
