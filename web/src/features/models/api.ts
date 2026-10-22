import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  DeletePublishedModelRequestSchema,
  ListPublishedModelsRequestSchema,
  PublishedModelSchema,
  SavePublishedModelRequestSchema,
  type PublishedModel,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { assertOk, describeError } from '@/lib/errors'

export const publishedModelKeys = {
  all: ['published-models'] as const,
}

export function usePublishedModels() {
  const client = useAdminClient()
  return useQuery({
    queryKey: publishedModelKeys.all,
    queryFn: () =>
      client.listPublishedModels(create(ListPublishedModelsRequestSchema)),
  })
}

/**
 * 新建或者改一个主路由模型。model.id 为空表示新建。
 *
 * 服务端用 ok:false 表达「模型至少要有一个上游」这类失败，这里翻成异常，
 * 页面拿到的是 reject，不会把失败当成功报出去。
 */
export function useSavePublishedModel() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: PublishedModel) => {
      const result = await client.savePublishedModel(
        create(SavePublishedModelRequestSchema, {
          model: create(PublishedModelSchema, input),
        })
      )
      assertOk(result, '没保存成')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已保存')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: publishedModelKeys.all })
    },
  })
}

/** 删掉一个主路由模型。 */
export function useDeletePublishedModel() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const result = await client.deletePublishedModel(
        create(DeletePublishedModelRequestSchema, { id: input.id })
      )
      assertOk(result, '没删掉')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '已删掉')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: publishedModelKeys.all })
    },
  })
}
