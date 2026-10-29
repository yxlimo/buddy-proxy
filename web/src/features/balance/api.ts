import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GetBalanceRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { describeError } from '@/lib/errors'

const balanceKeys = {
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

/**
 * 「刷新额度」：现在就去问一趟上游。
 *
 * 为什么不用查询上的 force 参数：那种查询一挂载就发请求，每次打开面板都会
 * 去问一轮上游。强制刷新是用户点了按钮才做的事，所以走 mutation。
 *
 * 拿回来的额度直接写回列表的缓存：用户点一下看到的就是刚问回来的数。
 * 上游没报额度就是空的 —— 不拿旧数顶上，也不写 0。
 */
export function useRefreshBalance(upstreamId: string) {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      client.getBalance(
        create(GetBalanceRequestSchema, { upstreamId, force: true })
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(balanceKeys.all(upstreamId), data)
      toast.success('额度已刷新')
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
  })
}
