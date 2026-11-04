import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AddPlatformRequestSchema,
  DeletePlatformRequestSchema,
  ListPlatformKindsRequestSchema,
  ListQuotaPluginsRequestSchema,
  RefreshPlatformModelsRequestSchema,
  UpdatePlatformRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { assertOk, describeError } from '@/lib/errors'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'

/** 额度插件登记表的查询键。键本身在 `lib/query-keys.ts` 里。 */
export const quotaPluginKeys = queryKeys.quotaPlugins

/**
 * 面板能选的额度插件。
 *
 * 插件是服务端登记的：面板不问「哪些平台有额度接口」，问登记表。用户自己填的
 * 插件 id 要是没登记，登记表里就没有它 —— 面板照样存得下去，只是额度那格显示
 * 「未知」，不假装知道。
 */
export function useQuotaPlugins() {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.quotaPlugins.all,
    queryFn: () =>
      client.listQuotaPlugins(create(ListQuotaPluginsRequestSchema)),
  })
}

/** 平台类型的查询键。键本身在 `lib/query-keys.ts` 里。 */
export const platformKindKeys = queryKeys.platformKinds

/**
 * 建平台时能选的类型（方言）。
 *
 * 清单是服务端登记的：面板不写死「openai / anthropic」这两条。服务端加一种
 * 方言，下拉与卡片就跟着多一种；面板旧了、清单里有它不认识的 kind，就摆 raw
 * 值（说不准的地方见 `platform-kinds.ts`）。
 */
export function useListPlatformKinds() {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.platformKinds.all,
    queryFn: () => client.listPlatformKinds(create(ListPlatformKindsRequestSchema)),
  })
}

/**
 * 加一个开放平台。
 *
 * 只建空平台：不接 key、不接模型清单（那是后面的事）。失败走答复里的 ok/message
 * —— 服务端说 id 不行就是不行，面板不自己写一套 id 规则。
 *
 * 错误不在这里弹 toast：新增的表单在弹窗里，错误显示在表单旁边更显眼（弹窗里
 * 那句见 platform-dialog.tsx）。
 */
export function useAddPlatform() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      label: string
      baseUrl: string
      /** 用哪一类适配器：清单里的一个 kind。 */
      kind: string
    }) => {
      const result = await client.addPlatform(
        create(AddPlatformRequestSchema, {
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          kind: input.kind,
        })
      )
      assertOk(result, '没加上这个平台')
      return result
    },
    onSuccess: (result) => {
      toast.success(result.message || '加上了')
    },
    onSettled: () => {
      // 平台表多了一行。
      invalidateServerData(queryClient, 'platforms')
    },
  })
}

/**
 * 改一个开放平台。
 *
 * UpdatePlatform 是整单提交：改一个字段也要把现在的值一起带上，空串表示清空。
 * 所以这里带的永远是那一整单（名字、地址、插件、模型目录），不是只发改动的
 * 那几格。
 */
export function useUpdatePlatform() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      label: string
      baseUrl: string
      quotaPlugin: string
      modelsAuto: boolean
      models: string[]
    }) => {
      const result = await client.updatePlatform(
        create(UpdatePlatformRequestSchema, {
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          quotaPlugin: input.quotaPlugin,
          modelsAuto: input.modelsAuto,
          models: input.models,
        })
      )
      assertOk(result, '没改成')
      return result
    },
    onSuccess: (result) => {
      toast.success(result.message || '改好了')
    },
    onSettled: () => {
      // 名字、地址、额度插件、模型目录都是平台那一行上的字段。
      invalidateServerData(queryClient, 'platforms')
    },
  })
}

/**
 * 删一个开放平台。
 *
 * 服务端连它名下的账号、凭据、额度、冷却一起删。被主路由模型引用时服务端会
 * 拒绝并说明引用了哪些 —— 面板照那句话显示。
 */
export function useDeletePlatform() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const result = await client.deletePlatform(
        create(DeletePlatformRequestSchema, { id: input.id })
      )
      assertOk(result, '没删掉')
      return result
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: (result) => {
      toast.success(result.message || '删掉了')
    },
    onSettled: () => {
      // 服务端连它名下的账号、凭据、额度一起删了。失败也可能是删了一半
      // （先删指着它的主路由模型），所以同样让这几摊失效。
      invalidateServerData(queryClient, 'platforms', 'accounts')
    },
  })
}

/**
 * 手动拉一次上游的模型目录。
 *
 * 拉不到不是错误：ok=false 时原来那份目录留着，答复里的 message 说明为什么没
 * 拉到。面板照答复显示，不自己判断原因。
 *
 * 拉完目录与拉取时刻都在服务端那边（ListUpstreams 的 Upstream 上那三格），
 * 面板不自己留一份：留一份就会跟服务端那份对不上（拉失败的时候尤其明显）。
 */
export function useRefreshPlatformModels() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { platformId: string }) => {
      return await client.refreshPlatformModels(
        create(RefreshPlatformModelsRequestSchema, {
          platformId: input.platformId,
        })
      )
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSettled: () => {
      // 目录与上次拉取时刻在平台那一行上；ok=false 时服务端也记了这次问过。
      invalidateServerData(queryClient, 'platforms')
    },
  })
}
