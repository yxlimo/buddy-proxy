import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { GetBalanceRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

export const balanceKeys = {
  all: (upstreamId: string) => ['balance', upstreamId] as const,
}

/**
 * 额度。upstreamId 为空表示所有上游。
 *
 * 回来的每一条是一个账号的额度：余额、积分、套餐额度，三样各是各的，
 * 前端不把它们加起来。
 */
export function useBalance(upstreamId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: balanceKeys.all(upstreamId),
    queryFn: () =>
      client.getBalance(create(GetBalanceRequestSchema, { upstreamId })),
  })
}
