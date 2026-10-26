// lib/zcode/models.ts — ZCode 的模型目录。
//
// ZCode 不用联网拉目录：它的模型表是内置的静态 JSON
// （config/provider/zcode-builtin.json，仓库里 revision 33）。
//
// 每个模型的 context / output / 思考档位都取自那份 JSON 的 `modelConfigRules`
// （按 `modelMatch` 正则逐条合并，后面的覆盖前面的）：
//
//   .*glm-5.*          → context 200000、output 64000（兜底）
//   .*glm-5\.3.*       → context 1000000、output 128000、档位 low/high/max
//   .*glm-5\.3-flash.* → 只改了输入格式（支持图片/视频/PDF）
//
// 客户端那份 static 目录里还挂着 GLM-5.2 与 GLM-5-Turbo，但平台按账号限定的
// capabilities 里没有它们（只有 `model:glm-5.3` 与 `model:glm-5.3-flash`），
// 发了也是 400 code 3006 `model not allowed`。实测确认后从目录里删了，
// 免得 agent 选到用不了的模型。
//
// **平台还会按账号限定能用哪些模型**：额度接口的每个桶带 capabilities
// （`model:glm-5.3-flash` 这样）。不在这份清单里的模型，上游回 400 code 3006
// `model not allowed`，所以公布目录时就用这份清单过滤（见
// `setZcodeCapabilities` / `zcodeModelsInUse`）。
//
// 依据：docs/zcode/FINDINGS.md §8、§9。

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

/** 目录里的模型。Start Plan 只给这两个（平台 capabilities 也只报这两个）。 */
export const ZCODE_MODELS: ZcodeModel[] = [
  {
    id: "GLM-5.3",
    displayName: "GLM-5.3",
    context: 1_000_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
    efforts: ["low", "high", "max"],
  },
  {
    id: "GLM-5.3-Flash",
    displayName: "GLM-5.3-Flash",
    context: 1_000_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
    efforts: ["low", "high", "max"],
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

/**
 * 平台说这个账号能用哪些模型（小写，`model:` 前缀去掉）。
 *
 * 额度接口的 capabilities 就是这个清单。没拉到额度之前是 null —— 那时候
 * 不做事先的过滤，公布整个目录（宁可让上游回 3006，也别把能用的模型藏了）。
 */
let entitled: Set<string> | null = null;

/** 记住平台说的权益。空清单等于「不知道」，不拿来过滤。 */
export function setZcodeCapabilities(caps: string[]): void {
  const names = caps
    .map((c) => String(c ?? "").trim())
    .filter((c) => c.toLowerCase().startsWith("model:"))
    .map((c) => c.slice("model:".length).trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) return;
  entitled = new Set(names);
}

/** 权益清单（测试用）。 */
export function zcodeCapabilities(): Set<string> | null {
  return entitled;
}

/** 这个账号能用（或者还不知道）的模型。 */
export function zcodeModelsInUse(): ZcodeModel[] {
  const caps = entitled;
  if (!caps) return ZCODE_MODELS;
  const usable = ZCODE_MODELS.filter((m) => caps.has(m.id.toLowerCase()));
  // 一个都对不上时不要公布空目录：那等于说网关连模型都没有。
  return usable.length ? usable : ZCODE_MODELS;
}

/**
 * 把 agent 要的思考档位换成这个模型认的那个。
 *
 * 各模型的档位不一样（glm-5.3 是 low/high/max，glm-5.2 是 high/max）。
 * 要的值不在清单里时取最近的，往**深**的那边靠（思考多点比少点安全）。
 */
export function zcodeEffortFor(id: string, wanted: string): string {
  const entry = matchZcodeModel(id);
  const allowed = entry?.efforts ?? [];
  const want = String(wanted ?? "").trim().toLowerCase();
  if (!allowed.length) return want;
  if (allowed.includes(want)) return want;

  // 档位从浅到深排一个梯子，用来量距离。
  const ladder = ["disabled", "minimal", "low", "medium", "high", "max"];
  const at = (value: string) => {
    const i = ladder.indexOf(value);
    return i < 0 ? ladder.indexOf("medium") : i;
  };
  const target = at(want);
  let best = allowed[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const option of allowed) {
    const distance = at(option) - target;
    // 先比距离，同距离时取更深的那档。
    const score = Math.abs(distance) * 10 - (distance >= 0 ? 1 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best;
}
