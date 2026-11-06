import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListConfigRequestSchema,
  SetConfigRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { assertOk, describeError } from '@/lib/errors'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'

export function useConfig() {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.config.all,
    queryFn: () => client.listConfig(create(ListConfigRequestSchema)),
  })
}

/**
 * 改一项配置。clear 为真表示清掉覆盖，回到环境变量或默认值。
 *
 * 服务端用 ok:false 表达「不认识的配置项」，这里翻成异常。
 */
export function useSetConfig() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      key: string
      value: string
      clear: boolean
    }) => {
      const result = await client.setConfig(
        create(SetConfigRequestSchema, {
          key: input.key,
          value: input.value,
          clear: input.clear,
        })
      )
      assertOk(result, '保存失败')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已保存，已经生效')
    },
    onSettled: () => {
      // 配置项那一页，和总览里那几个跟配置有关的数。
      invalidateServerData(queryClient, 'config')
    },
  })
}
