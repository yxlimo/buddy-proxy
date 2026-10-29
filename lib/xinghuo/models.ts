// lib/xinghuo/models.ts — 讯飞星火能用的模型，写死的一份。
//
// 星火没有可查的模型目录接口，所以这里只写我们真能调的那一个。
// 上下文长度与输出上限平台没报，不填 —— 填了就是编的。

import type { CatalogModel } from "../catalog-models.ts";

/**
 * 讯飞的模型：先写死一个。它没有可查的模型目录接口。
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
