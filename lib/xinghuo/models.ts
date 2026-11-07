// lib/xinghuo/models.ts — 讯飞星火能用的模型，写死的一份。
//
// 目录本身从上游拉（`/v2/models`）：这里只提供按 id 查的元数据 —— 上游那份清单
// 一个参数也不带，上下文长度与输出上限只有这里说得出来。填不出来的不填，
// 填了就是编的。

import type { CatalogModel } from "../catalog-models.ts";

/**
 * 讯飞的模型：先写死一个（目录是上游报的那份，这里是元数据）。
 */
export const XINGHUO_MODELS: CatalogModel[] = [
  { id: "Spark-X2.6", displayName: "Spark X2.6", reasoning: true, toolCall: true },
];

/**
 * 目录里的模型，渲染成公布的形状。
 *
 * 公布的只有平台说过的那几项：上下文长度、输出上限它都没报，所以不公布。
 */
export function xinghuoCatalogModels(models: CatalogModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
  }));
}
