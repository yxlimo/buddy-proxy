import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ListConfigRequestSchema,
  SetConfigRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { systemKeys } from '@/features/overview/api'
import { assertOk, describeError } from '@/lib/errors'

const configKeys = {
  all: ['config'] as const,
}

export function useConfig() {
  const client = useAdminClient()
  return useQuery({
    queryKey: configKeys.all,
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
      assertOk(result, '没保存成')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已保存，已经生效')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.all })
      void queryClient.invalidateQueries({ queryKey: systemKeys.status })
    },
  })
}
