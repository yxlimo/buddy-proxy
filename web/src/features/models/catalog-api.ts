import { create } from '@bufbuild/protobuf'
import { useQuery } from '@tanstack/react-query'
import { ListModelsRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamState } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'

const catalogKeys = {
  /**
   * 目录的缓存键带上了上游的状态。
   *
   * 上游关着的时候 ListModels 不返回它的模型 —— 开关变了、目录也变了，
   * 键不变的话界面上会留着上一次的目录（看着像还有模型，其实已经关了）。
   */
  models: (upstreamId: string, state: UpstreamState) =>
    ['catalog', upstreamId, state] as const,
}

/**
 * 某个上游组的模型目录。
 *
 * 选了「上游组」之后，模型 id 应该从目录里选，而不是让用户猜。
 * 有的组没有目录（上游没开、上游那边不给），这时候返回空，界面退回手填。
 */
export function useCatalogModels(upstreamId: string, state: UpstreamState) {
  const client = useAdminClient()
  return useQuery({
    queryKey: catalogKeys.models(upstreamId, state),
    queryFn: () =>
      client.listModels(
        create(ListModelsRequestSchema, { upstreamId })
      ),
    enabled: upstreamId.trim() !== '',
    retry: false,
  })
}
