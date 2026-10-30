// lib/workbuddy/models.ts — the China-region WorkBuddy catalogue.
//
// WorkBuddy's own desktop client publishes the catalogue at GET /v3/config
// (`agents[].models` holds the ids, a `models[]` array holds the metadata).
// The upstream ships new models without a client release, so the live list is
// the source of truth.
//
// **The table below is not a cache.** It is the bootstrap value: the list that
// was measured on 2026-10-21, used only until the gateway has fetched the
// upstream's own catalogue for the first time. The catalogue itself lives in
// the database (lib/workbuddy/catalog-store.ts) — the last one that was
// fetched successfully, kept there whatever its age, so a restart does not
// fall back to a table that is missing the models the upstream added.
//
// The list mirrors what the official picker shows: the inline-completion models
// and the multi-cloud variants (`-volc`, `-lkeap`, `-taiji`) are dropped, the
// paid build of a name (`-x`, `-sg`) is dropped when a free sibling exists,
// and the tier aliases (`auto`, `lite`, ...) are not models.
//
// `credits` is the multiplier the account is charged at: 0 means the model is
// free, 1.62 means it costs 1.62 times the base rate.

export interface WorkBuddyModel {
  id: string;
  display_name: string;
  /** Credit multiplier: 0 is free. */
  credits: number;
  /** Context window in tokens. */
  context: number;
  /** Maximum output in tokens. */
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** The model always thinks; there is no switch to turn it off. */
  onlyReasoning: boolean;
  /** Effort levels the model accepts. Empty means the level is not selectable. */
  efforts: string[];
  /** The temperature the simulated client sends for this model. */
  temperature?: number;
  /** The top_p the simulated client sends for this model. */
  topP?: number;
}

export const WORKBUDDY_CN_MODELS: WorkBuddyModel[] = [
  {
    id: "hy4-preview",
    display_name: "Hy4 preview",
    credits: 0.29,
    context: 960000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["high"],
  },
  {
    id: "hy3",
    display_name: "Hy3",
    credits: 0,
    context: 192000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "hy3-x",
    display_name: "Hy3",
    credits: 0.05,
    context: 192000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "step-5-preview",
    display_name: "Step-5-Preview",
    credits: 0,
    context: 1000000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "space-bunny",
    display_name: "Space-Bunny",
    credits: 0.08,
    context: 1000000,
    maxOutput: 128000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "deepseek-v4.1-flash",
    display_name: "Deepseek-V4.1-Flash",
    credits: 0.11,
    context: 1000000,
    maxOutput: 128000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "high", "max"],
  },
  {
    id: "glm-5.3",
    display_name: "GLM-5.3",
    credits: 0.69,
    context: 1000000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "high", "max"],
  },
  {
    id: "glm-5.3-flash",
    display_name: "GLM-5.3-Flash",
    credits: 0.08,
    context: 1000000,
    maxOutput: 131072,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "high", "max"],
  },
  {
    id: "glm-5.2",
    display_name: "GLM-5.2",
    credits: 0.79,
    context: 1000000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "glm-5.1",
    display_name: "GLM-5.1",
    credits: 0.79,
    context: 200000,
    maxOutput: 48000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "glm-5v-turbo",
    display_name: "GLM-5v-Turbo",
    credits: 0.71,
    context: 200000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "minimax-m3.1-flash",
    display_name: "MiniMax-M3.1-Flash",
    credits: 0.08,
    context: 1000000,
    maxOutput: 128000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "minimax-m3",
    display_name: "MiniMax-M3",
    credits: 0.25,
    context: 512000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "minimax-m2.7",
    display_name: "MiniMax-M2.7",
    credits: 0.19,
    context: 200000,
    maxOutput: 48000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "kimi-k3-1",
    display_name: "Kimi-K3",
    credits: 1.62,
    context: 1000000,
    maxOutput: 32000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "kimi-k2.8-preview",
    display_name: "Kimi-K2.8-Preview",
    credits: 0.77,
    context: 1000000,
    maxOutput: 64000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: ["low", "high", "max"],
  },
  {
    id: "kimi-k2.7",
    display_name: "Kimi-K2.7-Code",
    credits: 0.57,
    context: 256000,
    maxOutput: 32000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "kimi-k2.6",
    display_name: "Kimi-K2.6",
    credits: 0.52,
    context: 256000,
    maxOutput: 32000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "deepseek-v4-pro",
    display_name: "Deepseek-V4-Pro",
    credits: 0.51,
    context: 1000000,
    maxOutput: 128000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
  {
    id: "mimo-v2.6-pro",
    display_name: "Xiaomi MiMo-V2.6-Pro",
    credits: 0.13,
    context: 1000000,
    maxOutput: 128000,
    vision: true,
    tools: true,
    reasoning: true,
    onlyReasoning: true,
    efforts: [],
  },
];

const BY_ID = new Map(WORKBUDDY_CN_MODELS.map((m) => [m.id, m]));

export function workbuddyModel(id: string): WorkBuddyModel | undefined {
  return BY_ID.get(id);
}

/** The label a client shows: name plus the credit multiplier. */
export function workbuddyLabel(m: WorkBuddyModel): string {
  const rate = m.credits === 0 ? "免费" : `${m.credits}×`;
  return `${m.display_name} ${rate}`;
}

/* ---------------- the live catalogue ---------------- */

/** The upstream publishes the catalogue at GET /v3/config. */
export interface RemoteCatalog {
  ids: string[];
  meta: Record<string, Partial<WorkBuddyModel>>;
}

/** Models that are not chat models: completion-only, or an alias. */
const NON_CHAT_PREFIXES = ["codewise-", "completion-"];
const NON_CHAT_SUFFIXES = ["-image-alpha", "-image-alpha-edit", "-taco-completion"];
const NON_CHAT_MODELS = new Set(["lite", "default", "default-1", "default-1.1", "default-1.2"]);

/**
 * Models the upstream cannot serve.
 *
 * Measured 2026-10-21: every request for glm-5.1 was rejected with code 11133
 * ("the request parameters were rejected by the model provider"), whatever the
 * body says. The upstream has since dropped it from its catalogue, but the
 * snapshot still carries it — and a model that fails every time it is picked
 * must not show up in a list.
 */
const BROKEN_MODELS = new Set(["glm-5.1"]);

function isChatModel(id: string): boolean {
  if (!id) return false;
  if (NON_CHAT_MODELS.has(id)) return false;
  if (NON_CHAT_PREFIXES.some((p) => id.startsWith(p))) return false;
  if (NON_CHAT_SUFFIXES.some((s) => id.endsWith(s))) return false;
  return true;
}

/**
 * The bootstrap list, trimmed like the live catalogue.
 *
 * It is what the router publishes until the database holds a catalogue of its
 * own, so it has to go through the same rules: a model the upstream rejects
 * must not show up there either.
 */
export function workBuddyFallbackModels(): WorkBuddyModel[] {
  return WORKBUDDY_CN_MODELS.filter((m) => isChatModel(m.id) && !BROKEN_MODELS.has(m.id));
}

/** "x0.51 credits" → 0.51 */
function parseCredits(raw: unknown): number {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return 0;
  const n = Number(text.replace(/^x/, "").replace(/\s*credits\s*$/, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the catalogue out of a /v3/config answer.
 *
 * The picker list rides in `agents[].models` as bare ids; the per-model
 * metadata lives in a separate `models[]` array. An unusable credential
 * answers 200 with an empty list, which is not a catalogue.
 */
export function parseRemoteCatalog(payload: any): RemoteCatalog | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data ?? payload;
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const lists = agents
    .filter((a: any) => Array.isArray(a?.models))
    .map((a: any) => a.models as string[])
    .filter((l: string[]) => l.length);
  const best = lists.sort((a: string[], b: string[]) => b.length - a.length)[0];
  if (!best?.length) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of best) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const meta: Record<string, Partial<WorkBuddyModel>> = {};
  const walk = (node: any): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const models = node.models;
    if (Array.isArray(models) && models[0] && typeof models[0] === "object" && models[0].id) {
      for (const item of models) {
        const id = String(item.id ?? "").trim();
        if (!id) continue;
        meta[id] = {
          display_name: item.name ?? meta[id]?.display_name,
          credits: parseCredits(item.credits),
          context: item.maxInputTokens ?? item.contextWindow?.defaultLength ?? meta[id]?.context,
          maxOutput: item.maxOutputTokens ?? meta[id]?.maxOutput,
          vision: item.supportsImages ?? meta[id]?.vision,
          tools: item.supportsToolCall ?? meta[id]?.tools,
          reasoning: item.supportsReasoning ?? meta[id]?.reasoning,
          onlyReasoning: item.onlyReasoning ?? meta[id]?.onlyReasoning,
          efforts: Array.isArray(item.reasoning?.supportedEfforts)
            ? item.reasoning.supportedEfforts
            : (meta[id]?.efforts ?? []),
          temperature: typeof item.temperature === "number" ? item.temperature : meta[id]?.temperature,
          topP: typeof (item.topP ?? item.top_p) === "number" ? (item.topP ?? item.top_p) : meta[id]?.topP,
        };
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(payload);

  return { ids, meta };
}

/**
 * Trim the catalogue to what the official picker shows: no completion-only
 * models and no aliases.
 *
 * The official list keeps the paid build of a name and the free build of the
 * same name side by side — `hy3` and `hy3-x`, `hy4-preview` and
 * `hy4-preview-x` — so both are published here too. The picker shows what
 * each one costs, and the agent decides.
 */
export function curateCatalog(remote: RemoteCatalog, extra: string[] = []): WorkBuddyModel[] {
  const credits: Record<string, number> = {};
  for (const [id, m] of Object.entries(remote.meta)) {
    if (typeof m.credits === "number") credits[id] = m.credits;
  }
  // A model the snapshot knows but the live list does not still tells us what a
  // free sibling looks like.
  for (const m of WORKBUDDY_CN_MODELS) {
    if (credits[m.id] === undefined) credits[m.id] = m.credits;
  }

  // The upstream catalogue is a view of what a region offers, not the boundary
  // of it: measured 2026-10-31, the China backend answers `deepseek-v4.1-flash`
  // with 200 while its own /v3/config never names it, and every model in the
  // bundled China table answered too. So the caller may hand in models that are
  // known to work and are missing from the list; they go in the same door and
  // are filtered by the same rules.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...remote.ids, ...extra]) {
    if (!id || seen.has(id)) continue;
    if (!isChatModel(id)) continue;
    if (BROKEN_MODELS.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return mergeWorkBuddyCatalog(out, remote.meta);
}

/**
 * Keep the live catalogue in line with the snapshot: a model the upstream adds
 * is usable even if it is not in the table yet, so it is added with unknown
 * limits rather than hidden.
 */
export function mergeWorkBuddyCatalog(
  ids: string[],
  meta: Record<string, Partial<WorkBuddyModel>> = {},
): WorkBuddyModel[] {
  const out: WorkBuddyModel[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = BY_ID.get(id);
    const extra = meta[id] ?? {};
    if (!known) {
      out.push({
        id,
        display_name: extra.display_name ?? id,
        credits: extra.credits ?? 0,
        context: extra.context ?? 200000,
        maxOutput: extra.maxOutput ?? 8192,
        vision: extra.vision ?? true,
        tools: extra.tools ?? true,
        reasoning: extra.reasoning ?? false,
        onlyReasoning: extra.onlyReasoning ?? false,
        efforts: extra.efforts ?? [],
      });
      continue;
    }
    out.push({ ...known, ...extra, id, display_name: extra.display_name ?? known.display_name });
  }
  return out;
}

/**
 * The thinking level a model accepts.
 *
 * The official client clamps the level a request asks for to the ones the
 * model supports, and it clamps downwards: the level below the one asked for
 * is used. A level that is not a level at all falls back to the smallest one
 * the model supports.
 *
 * A model that lists no levels takes everything, except that the two levels
 * above `high` become `high` — those are the ones the simulated client never sends.
 */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function clampEffort(requested: string | undefined, supported: string[]): string | undefined {
  if (!requested) return undefined;
  const wanted = requested.toLowerCase();
  if (!supported.length) {
    return wanted === "max" || wanted === "xhigh" ? "high" : wanted;
  }
  const order = EFFORT_LEVELS;
  const index = order.indexOf(wanted);
  if (index < 0) return supported[0];
  for (let i = index; i >= 0; i--) {
    if (supported.includes(order[i])) return order[i];
  }
  return supported[0];
}

// The catalogue the gateway is serving right now, one per region.
//
// It lives here, with the thing that refreshes it, so the registry and the
// router can both read it. The copy in the database is the one that counts;
// this is it, in memory. The gateway loads it from the database when it starts
// (lib/workbuddy/catalog-store.ts), so the first request already sees the
// catalogue the upstream published — not the bootstrap table.
//
// **Per region, not per kind.** workbuddy.cn and workbuddy.ai each publish their
// own list, and the two barely overlap: a model one of them serves the other
// does not serve at all. This used to be one shared array, so whichever region
// fetched last won and the other one was handed a list of names its own
// upstream has never heard of — every request to it answered
// `11102 model [x] service info not found`.
const workbuddyModelsByRegion = new Map<string, WorkBuddyModel[]>();

/** The catalogue the gateway is serving right now, for one region. */
export function workbuddyModelList(region: string = "cn"): WorkBuddyModel[] {
  // The bundled table is the China catalogue, so it may only stand in for
  // China. A region that has never been fetched has nothing to answer with.
  return workbuddyModelsByRegion.get(region) ?? (region === "cn" ? workBuddyFallbackModels() : []);
}

/** Replace one region's catalogue (the upstream reported a new one, or the database had one). */
export function setWorkbuddyModelList(models: WorkBuddyModel[], region: string = "cn"): void {
  workbuddyModelsByRegion.set(region, models);
}
