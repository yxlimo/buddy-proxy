// lib/zcode/models.ts — ZCode 的模型目录。
//
// ZCode 不用联网拉目录：它的模型表是内置的静态 JSON
// （config/provider/zcode-builtin.json，仓库里 revision 33）。
// Start Plan 那一条（account:zai-start-plan）下面就是三个模型：
//
//   GLM-5.3-Flash、GLM-5.2、GLM-5-Turbo
//
// 客户端启动时还会问平台「这个账号能用哪些模型」，答案在额度的
// capabilities 里（`model:GLM-5.3-Flash` 这样）。网关这里给静态表 ——
// 平台说能用哪个，就让它在目录里；说不了的就不公布。
//
// 依据：docs/zcode/FINDINGS.md §8。

export interface ZcodeModel {
  id: string;
  displayName: string;
  context: number;
  output: number;
  reasoning: boolean;
  toolCall: boolean;
  /** 这个模型认哪些思考档位。 */
  efforts: string[];
}

/** Start Plan 的模型。 */
export const ZCODE_MODELS: ZcodeModel[] = [
  {
    id: "GLM-5.3-Flash",
    displayName: "GLM-5.3-Flash",
    context: 200_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "GLM-5.2",
    displayName: "GLM-5.2",
    context: 200_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "GLM-5-Turbo",
    displayName: "GLM-5-Turbo",
    context: 200_000,
    output: 128_000,
    reasoning: false,
    toolCall: true,
    efforts: [],
  },
];

/** 目录里有的模型 id。 */
export function zcodeModelIds(): Set<string> {
  return new Set(ZCODE_MODELS.map((m) => m.id));
}

/** 按 id 找一个模型。大小写不敏感 —— agent 写的和客户端写的可能不一样。 */
export function matchZcodeModel(id: string): ZcodeModel | null {
  const exact = ZCODE_MODELS.find((m) => m.id === id);
  if (exact) return exact;
  const lower = id.toLowerCase();
  return ZCODE_MODELS.find((m) => m.id.toLowerCase() === lower) ?? null;
}

/** 这个模型能输出多少。查不到就说不知道，不拿别的数来填。 */
export function zcodeMaxOutput(id: string): number {
  return matchZcodeModel(id)?.output ?? 0;
}
