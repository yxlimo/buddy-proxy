// lib/workbuddy/models.ts — the China-region WorkBuddy catalogue.
//
// WorkBuddy's own desktop client publishes a catalogue at GET /v3/config
// (`agents[].models` holds the ids, a `models[]` array holds the metadata), and
// the upstream ships new models without a client release. What that answer does
// **not** carry for a cn account is the credit multiplier and the thinking
// levels (measured, and no header changes it — see
// docs/tasks/open-platform/s13b-workbuddy-ua-diff.md), so a catalogue built from
// it alone publishes the models with no price and no effort picker.
//
// The China table therefore comes from the desktop client's own product config:
// `cn-catalog.json` is generated from it by scripts/workbuddy-catalog.ts and
// committed, and this file only reads it. The client config is what the official
// picker is built from, so it is the authority for this region.
//
// **The table is not a cache.** It is the bootstrap value, used only until the
// gateway has fetched the upstream's own catalogue for the first time. The
// catalogue itself lives in the database (lib/workbuddy/catalog-store.ts) — the
// last one that was fetched successfully, kept there whatever its age, so a
// restart does not fall back to a table that is missing the models the upstream
// added.
//
// The upstream may still correct a field, or name a model the table does not
// have — but only where it actually says something. A field it leaves out means
// "nothing to say", not "zero": an answer without `credits` used to write 0
// into the catalogue and made every model look free.
//
// `credits` is the multiplier the account is charged at: 0 means the model is
// free, 1.62 means it costs 1.62 times the base rate, null means the client
// config states no multiplier at all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export interface WorkBuddyModel {
  id: string;
  display_name: string;
  /** Credit multiplier: 0 is free, null is "the client config states none". */
  credits: number | null;
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
  /** The level used when the caller picks none; empty when nobody says. */
  defaultEffort?: string;
  /** Whether thinking can be turned off; null when the upstream did not say. */
  canDisableThinking?: boolean | null;
  /** The temperature the simulated client sends for this model. */
  temperature?: number;
  /** The top_p the simulated client sends for this model. */
  topP?: number;
}


const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One row of cn-catalog.json, in the shape scripts/workbuddy-catalog.ts writes. */
interface CatalogRow {
  id: string;
  name: string;
  credits: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  onlyReasoning: boolean;
  efforts: string[];
  defaultEffort: string;
  canDisableThinking: boolean | null;
}

/**
 * The bundled China table.
 *
 * Read once and kept in memory: it is a file that ships with the code, so
 * re-reading it per request would buy nothing. An unreadable file is not fatal
 * — a gateway with no bootstrap still serves whatever the upstream published —
 * so it answers an empty table instead of throwing at import time.
 */
function loadBundledCnCatalog(): WorkBuddyModel[] {
  let rows: CatalogRow[];
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(HERE, "cn-catalog.json"), "utf8"));
    rows = Array.isArray(doc?.models) ? (doc.models as CatalogRow[]) : [];
  } catch {
    return [];
  }
  return rows
    .filter((row) => typeof row?.id === "string" && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      display_name: row.name || row.id,
      credits: typeof row.credits === "number" ? row.credits : null,
      context: Number(row.contextWindow) || 200000,
      maxOutput: Number(row.maxOutputTokens) || 8192,
      vision: row.vision === true,
      tools: row.tools === true,
      reasoning: row.reasoning === true,
      onlyReasoning: row.onlyReasoning === true,
      efforts: Array.isArray(row.efforts) ? row.efforts.map(String) : [],
      ...(typeof row.defaultEffort === "string" && row.defaultEffort
        ? { defaultEffort: row.defaultEffort }
        : {}),
      canDisableThinking: typeof row.canDisableThinking === "boolean" ? row.canDisableThinking : null,
    }));
}

export const WORKBUDDY_CN_MODELS: WorkBuddyModel[] = loadBundledCnCatalog();

const BY_ID = new Map(WORKBUDDY_CN_MODELS.map((m) => [m.id, m]));

export function workbuddyModel(id: string): WorkBuddyModel | undefined {
  return BY_ID.get(id);
}

/** The label a client shows: name plus the credit multiplier, when there is one. */
export function workbuddyLabel(m: WorkBuddyModel): string {
  if (m.credits === null) return m.display_name;
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

/**
 * What a /v3/config model entry says about thinking.
 *
 * Two shapes come back. A model whose thinking level the user can pick lists
 * `supportedEfforts`; a model that always thinks at one fixed level carries a
 * bare `effort` and no list at all.
 *
 * A bare `effort` names the level the model runs at. It says nothing about
 * which levels are selectable, so it sets `defaultEffort` and leaves `efforts`
 * undefined. Writing `[]` there claimed "not one level" — and an empty list is
 * a value, so the merge threw away the levels the table has for the model
 * (`deepseek-v4-flash` lost `high`/`xhigh` that way). A model nobody lists
 * levels for still ends up with none, because the merge fills an absent list
 * with `[]`.
 *
 * A field the upstream does not mention is left out of the answer (undefined),
 * so the merge keeps what the table says. That is what separates "this model has
 * no levels" from "this answer did not say".
 */
function parseReasoning(reasoning: any): {
  efforts?: string[];
  defaultEffort?: string;
  canDisableThinking?: boolean;
} {
  if (!reasoning || typeof reasoning !== "object") return {};
  const out: { efforts?: string[]; defaultEffort?: string; canDisableThinking?: boolean } = {};
  const listed = reasoning.supportedEfforts;
  const fixed = reasoning.effort;
  if (Array.isArray(listed) && listed.length) out.efforts = listed.map(String);
  const chosen = reasoning.defaultEffort ?? fixed;
  if (typeof chosen === "string" && chosen.trim()) out.defaultEffort = chosen.trim();
  if (typeof reasoning.canDisableThinking === "boolean") {
    out.canDisableThinking = reasoning.canDisableThinking;
  }
  return out;
}

/**
 * "x0.51 credits" → 0.51.
 *
 * An empty `credits` is not a multiplier and not free either: it is the upstream
 * saying nothing, so it answers undefined and the merge leaves the table alone.
 * Writing 0 here was the bug that made every model look free.
 */
function parseCredits(raw: unknown): number | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^x/, "")
    .replace(/\s*credits\s*$/, "")
    .trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
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
        // Only the fields this entry actually carries go in: `{...known,
        // ...extra}` would otherwise wipe the table's value with an undefined
        // one, and a field the upstream left out is not a value.
        const entry: Partial<WorkBuddyModel> = { ...(meta[id] ?? {}) };
        if (typeof item.name === "string" && item.name.trim()) entry.display_name = item.name;
        const credits = parseCredits(item.credits);
        if (credits !== undefined) entry.credits = credits;
        const context = item.maxInputTokens ?? item.contextWindow?.defaultLength;
        if (typeof context === "number") entry.context = context;
        if (typeof item.maxOutputTokens === "number") entry.maxOutput = item.maxOutputTokens;
        if (typeof item.supportsImages === "boolean") entry.vision = item.supportsImages;
        if (typeof item.supportsToolCall === "boolean") entry.tools = item.supportsToolCall;
        if (typeof item.supportsReasoning === "boolean") entry.reasoning = item.supportsReasoning;
        if (typeof item.onlyReasoning === "boolean") entry.onlyReasoning = item.onlyReasoning;
        const thinking = parseReasoning(item.reasoning);
        if (thinking.efforts !== undefined) entry.efforts = thinking.efforts;
        if (thinking.defaultEffort !== undefined) entry.defaultEffort = thinking.defaultEffort;
        if (thinking.canDisableThinking !== undefined) {
          entry.canDisableThinking = thinking.canDisableThinking;
        }
        if (typeof item.temperature === "number") entry.temperature = item.temperature;
        const topP = item.topP ?? item.top_p;
        if (typeof topP === "number") entry.topP = topP;
        meta[id] = entry;
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
 * limits rather than hidden. A model the table knows keeps every field the
 * upstream did not send.
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
    const extra = withoutUndefined(meta[id] ?? {});
    if (!known) {
      out.push({
        id,
        display_name: extra.display_name ?? id,
        // Nobody said what it costs, so the list says nothing about it: 0 would
        // claim the model is free.
        credits: extra.credits ?? null,
        context: extra.context ?? 200000,
        maxOutput: extra.maxOutput ?? 8192,
        vision: extra.vision ?? true,
        tools: extra.tools ?? true,
        reasoning: extra.reasoning ?? false,
        onlyReasoning: extra.onlyReasoning ?? false,
        efforts: extra.efforts ?? [],
        ...(extra.defaultEffort !== undefined ? { defaultEffort: extra.defaultEffort } : {}),
        ...(extra.canDisableThinking !== undefined ? { canDisableThinking: extra.canDisableThinking } : {}),
        ...(extra.temperature !== undefined ? { temperature: extra.temperature } : {}),
        ...(extra.topP !== undefined ? { topP: extra.topP } : {}),
      });
      continue;
    }
    out.push({ ...known, ...extra, id, display_name: extra.display_name ?? known.display_name });
  }
  return out;
}

/** The entry without the keys whose value is undefined: an absent field, not a value. */
function withoutUndefined(entry: Partial<WorkBuddyModel>): Partial<WorkBuddyModel> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<WorkBuddyModel>;
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

/**
 * The catalogue a region **publishes** — which is not the same list as the one
 * that was fetched, and that difference is deliberate.
 *
 * What is fetched is the record of what the upstream said: every model it named,
 * kept as it came. What is published is what an agent is offered, and that is a
 * product decision:
 *
 *   cn       the bundled China table (lib/workbuddy/cn-catalog.json) is the base:
 *            it is what the official picker is built from for this region, it is
 *            filtered once (see `workBuddyFallbackModels`), and it carries the
 *            multiplier and the levels the upstream does not send. The fetched
 *            catalogue only corrects the fields of the models the table names
 *            (`mergeWorkBuddyCatalog` already did that when it was stored). A
 *            model the upstream added and the table does not have is **not**
 *            published — a hand-written override can add it back
 *            (lib/model-overrides.ts), which is the deliberate way to do it.
 *
 *   global   nothing in the table is about this region, so the upstream's own
 *            list is published as it is.
 *
 * The fetched list stays untouched in the database either way: it is the record
 * of what the upstream said, and dropping entries on the way in would make that
 * record impossible to read back.
 */
export function workbuddyPublishList(region: string = "cn"): WorkBuddyModel[] {
  const fetched = workbuddyModelList(region);
  if (region !== "cn") return fetched;
  // The table's order is the order an agent sees; a model the fetched answer knew
  // keeps every field it corrected.
  const fetchedById = new Map(fetched.map((model) => [model.id, model]));
  return workBuddyFallbackModels().map((model) => fetchedById.get(model.id) ?? model);
}
