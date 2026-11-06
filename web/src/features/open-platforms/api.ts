import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AddPlatformRequestSchema,
  DeletePlatformRequestSchema,
  DeleteModelOverrideRequestSchema,
  ListModelOverridesRequestSchema,
  ListPlatformKindsRequestSchema,
  ListQuotaPluginsRequestSchema,
  ModelOverrideSchema,
  RefreshPlatformModelsRequestSchema,
  SetModelOverridesRequestSchema,
  UpdatePlatformRequestSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { OverrideInput } from '@/features/open-platforms/model-overrides'
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
 * 只建空平台：不接 key、不接模型清单（那是后面的事）。服务端说 id 不行就是不行
 * —— 面板不自己写一套 id 规则，失败是一次 Connect 错误（`describeError` 翻）。
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
      return await client.addPlatform(
        create(AddPlatformRequestSchema, {
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          kind: input.kind,
        })
      )
    },
    onSuccess: () => {
      toast.success('已新增')
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
 * 整单提交：名字、地址、额度插件、模型目录一起发。
 *
 * 模拟客户端的地址与额度插件两格归代码：那种平台调用方整格不给（`undefined`）
 * —— 给空串在这条 RPC 上就是「清空那一格」（合同里 string 没有 presence 位，
 * 约定写在 `UpdatePlatformRequest` 的注释里）。不给的两格这里不往消息里放。
 *
 * `traitsFromCommon` 同理：它是 optional bool，不给 = 别动这一格。只有用户动过
 * 开关才带。
 */
export function useUpdatePlatform() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      label: string
      baseUrl?: string
      quotaPlugin?: string
      traitsFromCommon?: boolean
      modelsAuto: boolean
      models: string[]
    }) => {
      const init: MessageInitShape<typeof UpdatePlatformRequestSchema> = {
        id: input.id,
        label: input.label,
        modelsAuto: input.modelsAuto,
        models: input.models,
      }
      if (input.baseUrl !== undefined) init.baseUrl = input.baseUrl
      if (input.quotaPlugin !== undefined) init.quotaPlugin = input.quotaPlugin
      // optional bool：不放就是「别动这一格」。关掉时给的是 false，与不放不一样。
      if (input.traitsFromCommon !== undefined) {
        init.traitsFromCommon = input.traitsFromCommon
      }
      return await client.updatePlatform(
        create(UpdatePlatformRequestSchema, init)
      )
    },
    onSuccess: () => {
      toast.success('已保存')
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
 * 拒绝（一次 Connect 错误）并说明引用了哪些 —— 面板照那句话显示。
 */
export function useDeletePlatform() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      return await client.deletePlatform(
        create(DeletePlatformRequestSchema, { id: input.id })
      )
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
    onSuccess: () => {
      toast.success('已删除')
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
 * 拉不到不是错误：ok=false 时原来那份目录留着。面板上那句「已刷新，N 个模型」
 * 由面板自己按拉回来的条数说，不摆服务端那句 message —— 这一族答复里的文案
 * 归面板。
 *
 * ok=false 在这里翻成一次异常：成功与失败只有一条路，页面拿到 reject 就用
 * `describeError` 说原因（那句话显示在平台那一行下面）。
 *
 * 拉完目录与拉取时刻都在服务端那边（ListUpstreams 的 Upstream 上那三格），
 * 面板不自己留一份：留一份就会跟服务端那份对不上（拉失败的时候尤其明显）。
 */
export function useRefreshPlatformModels() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { platformId: string }) => {
      const result = await client.refreshPlatformModels(
        create(RefreshPlatformModelsRequestSchema, {
          platformId: input.platformId,
        })
      )
      assertOk(result, '刷新模型目录失败')
      return result
    },
    onSettled: () => {
      // 目录与上次拉取时刻在平台那一行上；ok=false 时服务端也记了这次问过。
      invalidateServerData(queryClient, 'platforms')
    },
  })
}

/**
 * 某个平台「人给模型写的元数据」。
 *
 * 目录本身来自 `ListModels`（`useCatalogModels`），这里只管人工那部分：哪些模型
 * 是人工补进来的、各自写了哪几格。模板平台与开放平台都有这一份。
 */
export function useModelOverrides(platformId: string) {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.modelOverrides.of(platformId),
    queryFn: () =>
      client.listModelOverrides(
        create(ListModelOverridesRequestSchema, { platformId })
      ),
    enabled: platformId.trim() !== '',
    retry: false,
  })
}

/**
 * 存某个平台的自定义模型。
 *
 * SetModelOverrides 按 id 覆盖：发来的每一条同 id 的换掉、新 id 的加进来，没发
 * 来的条目原封不动。所以弹窗一次只发当前在改的那一条，别的那几条不会被碰到。
 *
 * 错误不在这里弹 toast：弹窗不关、把服务端那句话摆在弹窗里更显眼（它会说清是
 * 哪一格不合法）。成功也不弹：弹窗关掉本身就是「存上了」。
 *
 * 失败是一次 Connect 错误（这一族方法没有 ok / message 两格），`describeError`
 * 会把它翻成人话。
 */
export function useSetModelOverrides() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      platformId: string
      overrides: OverrideInput[]
    }) => {
      return await client.setModelOverrides(
        create(SetModelOverridesRequestSchema, {
          platformId: input.platformId,
          overrides: input.overrides.map((item) =>
            create(ModelOverrideSchema, item)
          ),
        })
      )
    },
    onSettled: () => {
      // 目录、平台那行、人工那一份都是这一笔改的。失败里服务端也可能只写了一部分。
      invalidateServerData(queryClient, 'modelOverrides')
    },
  })
}

/**
 * 删一条人工条目。
 *
 * 覆盖语义下「没发来」不再等于删，删要有自己这一条路。这条不存在时服务端回
 * 一次 Connect 错误（不是静默成功），弹窗把 `describeError` 那句话显示出来。
 */
export function useDeleteModelOverride() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { platformId: string; modelId: string }) =>
      await client.deleteModelOverride(
        create(DeleteModelOverrideRequestSchema, {
          platformId: input.platformId,
          modelId: input.modelId,
        })
      ),
    onSettled: () => {
      // 人工那一份少了一条：目录、平台那行也跟着变。
      invalidateServerData(queryClient, 'modelOverrides')
    },
  })
}
