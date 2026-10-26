import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  GetBenefitStatusRequestSchema,
  RunBenefitNowRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { describeError } from '@/lib/errors'

export const benefitKeys = {
  all: ['benefits'] as const,
}

/**
 * 今天的签到状态。
 *
 * 面板不自己算「今天签没签」：后端说签了就是签了，说没签就是没签。这个 hook
 * 只是把后端给的那份原样取回来，一个字都不加工。
 *
 * 签到状态是所有账号一份的（契约里没有按平台筛这一说），所以 key 也不按平台
 * 分：几个平台共用一份，取一次就够。
 */
export function useBenefitStatus(options?: { enabled?: boolean }) {
  const client = useAdminClient()
  return useQuery({
    queryKey: benefitKeys.all,
    queryFn: () =>
      client.getBenefitStatus(create(GetBenefitStatusRequestSchema)),
    ...options,
  })
}

/**
 * 现在就签一次。
 *
 * 签到是全局的：一次把所有登记了签到的账号都跑一遍，契约里没有「只签某一个」
 * 这一说。跑完把签到状态标成过期，让界面重新取一遍后端记着的那份。
 */
export function useRunBenefitNow() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      client.runBenefitNow(create(RunBenefitNowRequestSchema)),
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      if (result.ok) {
        toast.success('签到跑完了')
        return
      }
      // 有账号没签到成功：具体是哪个账号、出了什么事，都在 lines 里，界面
      // 会把它们逐行给出来。这里只说一句结论。
      toast.error('有账号没签到成功')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: benefitKeys.all })
    },
  })
}
