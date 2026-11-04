import type { PublishedModel } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 哪些主路由模型指向这个平台。
 *
 * 判据只有一个：模型的目标里有一项的 group_name 等于平台的 id。group_name
 * 存的就是上游 id（面板上选 Provider 组时存的那个）。
 *
 * 删平台之前要先算一遍：指向它的主路由模型会跟着一起删（不删的话，删完平台
 * 那些模型就再也接不了了）。面板算这一遍是为了在删之前把话说明白，不是为了
 * 代替服务端的判断 —— 服务端删平台时自己也会看一遍。
 */
export function modelsReferencingPlatform(
  models: PublishedModel[],
  platformId: string
): PublishedModel[] {
  return models.filter((model) =>
    model.targets.some((target) => target.groupName === platformId)
  )
}
