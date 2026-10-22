import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { GetBalanceRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

export const balanceKeys = {
  all: (upstreamId: string) => ['balance', upstreamId] as const,
}

/**
 * 余额。upstreamId 为空表示所有上游。
 */
export function useBalance(upstreamId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: balanceKeys.all(upstreamId),
    queryFn: () =>
      client.getBalance(create(GetBalanceRequestSchema, { upstreamId })),
  })
}
