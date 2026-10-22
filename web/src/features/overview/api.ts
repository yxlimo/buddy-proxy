import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import {
  GetSystemStatusRequestSchema,
  GetUsageSummaryRequestSchema,
  type GetUsageSummaryRequest,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

export const systemKeys = {
  status: ['system', 'status'] as const,
  usage: (upstreamId: string, window: string) =>
    ['system', 'usage', upstreamId, window] as const,
}

export function useSystemStatus() {
  const client = useAdminClient()
  return useQuery({
    queryKey: systemKeys.status,
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
    queryKey: systemKeys.usage(input.upstreamId, input.window),
    queryFn: () => client.getUsageSummary(request),
  })
}

export type { GetUsageSummaryRequest }
