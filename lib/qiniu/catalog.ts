// lib/qiniu/catalog.ts — 模型目录：写死的那一份。
//
// 平台自己的 `/v1/models` 报 78 个，但那把 key 的商品分组只让一部分能用 ——
// 报出去的目录必须是我们真能调的，否则客户端挑一个就撞 403
// model_group_access_denied。目录写死在 lib/qiniu/models.ts，这里只负责把它
// 渲染成公布的形状。

import type { CatalogModel } from "../catalog-models.ts";

/**
 * 目录里的模型，渲染成公布的形状。
 *
 * 公布的只有平台说过的那几项：上下文长度、输出上限、思考档位它都没报，所以
 * 不公布（哪怕目录里多写了也不公布 —— 那是我们自己编的数）。
 */
export function qiniuCatalogModels(models: CatalogModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
  }));
}
