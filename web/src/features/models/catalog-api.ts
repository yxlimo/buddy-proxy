import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { ListModelsRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

export const catalogKeys = {
  models: (upstreamId: string) => ['catalog', upstreamId] as const,
}

/**
 * 某个上游组的模型目录。
 *
 * 选了「上游组」之后，模型 id 应该从目录里选，而不是让用户猜。
 * 有的组没有目录（上游没开、上游那边不给），这时候返回空，界面退回手填。
 */
export function useCatalogModels(upstreamId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: catalogKeys.models(upstreamId),
    queryFn: () =>
      client.listModels(
        create(ListModelsRequestSchema, { upstreamId })
      ),
    enabled: upstreamId.trim() !== '',
    retry: false,
  })
}
