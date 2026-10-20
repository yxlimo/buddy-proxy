// lib/qoder-models.ts — the Qoder model catalog, in both dialects.
//
// The gateway takes model *keys*, not display names, and there are two key
// vocabularies, one per protocol:
//
//   new    api2-v2.qoder.sh/model/v1/chat/completions — plain OpenAI, Bearer only
//   legacy api3.qoder.sh/algo/…/agent_chat_generation — COSY-signed, Qoder's own
//          request shape
//
// The new protocol accepts a small set of keys: `auto`, `ultimate`, `efficient`,
// `qmodel`, `kmodel`, `gmodel`, `dmodel`, `mmodel`. Everything else — including
// every display name — comes back as `invalid_model_error` / "Unsupported model".
//
// The legacy protocol accepts the CLI's own catalog keys, which include the
// version-pinned models the free flash tiers live under. Those are the ones the
// new protocol refuses: `dfmodel` (DeepSeek-Flash), `qfmodel` (Qwen3.8-Flash),
// `qmodel_38max` (Qwen3.8-Max), `cmodel` (Cantus), `smodel` (Sonus),
// `gfmodel` (GLM-5.3-Flash), `kmodel_latest` (Kimi-K2.8-Preview).
//
// So a model here carries three things: the id clients use, the key the gateway
// wants, and which protocol speaks it. The id is the real model name —
// `deepseek-flash`, not `dfmodel` — because that is what a user recognizes and
// what the router's `qoder/` prefix namespaces.
//
// The gateway also reports which backend a request landed on, in
// `usage.raw_usage.model`. Those are recorded here so a client can tell what it
// really got: `qmodel` is Bailian's Qwen3.7-Plus, `kmodel` is Kimi K2.7-Code,
// `gmodel` is GLM-5, `mmodel` is MiniMax-M2.5, and `auto` is Qoder's own
// qwen3-coder-plus.
//
// Which models are free depends on the account and the current promotion; the
// `billable`/`credits` fields in the usage are the authority, not the name.

import { readEnvString } from "./env.ts";

export type QoderProtocol = "new" | "legacy";

export interface QoderModel {
  /** Id clients use. The router prefixes it with `qoder/`. */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Credit multiplier as the Qoder client shows it ("0.5×"). It goes into the
   * label so the model list says what a request costs relative to the others.
   */
  multiplier?: string;
  /** The key the gateway expects. */
  key: string;
  protocol: QoderProtocol;
  reasoning: boolean;
  /** Backend the gateway reports for this model, when it reports one. */
  backend?: string;
  /** Context window the catalog advertises for this model. */
  context: number;
  /**
   * `model` pins one model. `tier` lets Qoder pick the model and only sets how
   * hard it thinks — the tiers are the same capability at different effort
   * levels, so they are exposed as effort variants of one entry rather than as
   * separate models.
   */
  kind: "model" | "tier";
  /** For tiers: the tier key this effort level maps to. */
  tierFor?: (effort: string) => string;
}

/**
 * Effort levels a tier entry accepts.
 *
 * The tiers are the same capability at different thinking budgets, so a client
 * picks one model and asks for an effort level; the proxy maps that to the tier
 * the gateway understands.
 */
export const QODER_EFFORTS = ["low", "medium", "high", "max"] as const;

/**
 * Effort → tier.
 *
 * Only two tiers are known to be reliably available: `auto` does not think, and
 * `ultimate` thinks. The other two (`efficient`, `fast`) sit on backends that are
 * frequently out of capacity, so the default mapping stays on the two that
 * work. Override with `QODER_EFFORT_TIERS=low=efficient,medium=auto,…`.
 */
const DEFAULT_EFFORT_TIERS: Record<string, string> = {
  minimal: "auto",
  low: "auto",
  medium: "auto",
  high: "ultimate",
  max: "ultimate",
};

/** Read the effort → tier mapping, allowing an override from the environment. */
export function effortTiers(): Record<string, string> {
  const raw = readEnvString("QODER_EFFORT_TIERS", "");
  if (!raw.trim()) return DEFAULT_EFFORT_TIERS;
  const map: Record<string, string> = { ...DEFAULT_EFFORT_TIERS };
  for (const pair of raw.split(",")) {
    const [effort, tier] = pair.split("=").map((s) => s?.trim());
    if (effort && tier) map[effort.toLowerCase()] = tier;
  }
  return map;
}

/** The tier an effort level maps to. */
export function tierForEffort(effort: string | undefined): string {
  if (!effort) return "auto";
  return effortTiers()[effort.toLowerCase()] ?? "auto";
}

export const QODER_MODELS: QoderModel[] = [
  // The tier entry: one model, four thinking levels. The tier decides how hard
  // Qoder thinks and which model it lands on.
  {
    id: "auto",
    name: "Auto",
    multiplier: "0.5×",
    key: "auto",
    protocol: "new",
    reasoning: true,
    backend: "qwen3-coder-plus",
    context: 200000,
    kind: "tier",
    tierFor: (effort) => tierForEffort(effort),
  },

  // Named models the new protocol accepts.
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus", multiplier: "0.1×", key: "qmodel", protocol: "new", reasoning: false, backend: "bailian-qwen3.7-plus", context: 1000000, kind: "model" },
  { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", multiplier: "0.8×", key: "kmodel", protocol: "new", reasoning: false, backend: "oem-kimi-k2.7-code", context: 180000, kind: "model" },
  { id: "glm-5.3", name: "GLM-5.3", multiplier: "0.8×", key: "gmodel", protocol: "new", reasoning: true, backend: "oem-glm-5", context: 180000, kind: "model" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", multiplier: "0.5×", key: "dmodel", protocol: "new", reasoning: true, backend: "oem-deepseek-v4-pro", context: 1000000, kind: "model" },
  // Qoder's catalog calls this MiniMax-M3.1-Flash, but the gateway reports the
  // backend it actually used as oem-minimax-m2.5 — a different generation. The
  // id keeps Qoder's wording (that is the name the tier is selected by); the
  // display name says what runs.
  { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash (→ M2.5)", multiplier: "0.1×", key: "mmodel", protocol: "new", reasoning: true, backend: "oem-minimax-m2.5", context: 1000000, kind: "model" },

  // Version-pinned models — the legacy protocol only.
  { id: "deepseek-flash", name: "DeepSeek-Flash", multiplier: "0×", key: "dfmodel", protocol: "legacy", reasoning: true, context: 1000000, kind: "model" },
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash", multiplier: "0×", key: "qfmodel", protocol: "legacy", reasoning: true, context: 180000, kind: "model" },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", multiplier: "0.5×", key: "qmodel_38max", protocol: "legacy", reasoning: true, context: 180000, kind: "model" },
  { id: "qwen3.7-max", name: "Qwen3.7-Max", multiplier: "0.5×", key: "qmodel_latest", protocol: "legacy", reasoning: false, context: 1000000, kind: "model" },
  { id: "kimi-k3", name: "Kimi-K3", multiplier: "1.4×", key: "kmodel_latest", protocol: "legacy", reasoning: false, context: 180000, kind: "model" },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", multiplier: "0.1×", key: "gfmodel", protocol: "legacy", reasoning: true, context: 1000000, kind: "model" },
  { id: "cantus", name: "Cantus", multiplier: "0×", key: "cmodel", protocol: "legacy", reasoning: true, context: 180000, kind: "model" },
  { id: "sonus", name: "Sonus", multiplier: "0×", key: "smodel", protocol: "legacy", reasoning: true, context: 180000, kind: "model" },
];

export const DEFAULT_MODEL_ID = "auto";

export type QoderRegion = "cn" | "global";

/**
 * The models a region can actually serve.
 *
 * The global gateway runs the new protocol only, and it accepts a small set of
 * keys: the version-pinned models (`dfmodel`, `qfmodel`, `qmodel_38max`,
 * `kmodel_latest`, `gfmodel`, `cmodel`, `smodel`) live on the legacy protocol
 * instead. On the global account that legacy path is not usable — it answers
 * 403 (queued), "All backends failed", and once the day's free count is used
 * up, 110 "Billing daily count exceeded" — so the global catalog leaves those
 * models out instead of advertising something that cannot answer.
 *
 * The CN gateway is the other way round: it has not deployed the new protocol
 * (404/503), and its legacy protocol accepts *both* vocabularies — the plain
 * keys (`qmodel`, `kmodel`, `gmodel`, `dmodel`, `mmodel`) as well as the
 * version-pinned ones. Measured 2026-10-20: 14 of the 17 keys answer, the two
 * effort tiers (`ultimate`, `efficient`) are not in its catalog, and
 * `dfmodel` sits in the queue and never clears.
 */
const CN_UNAVAILABLE = new Set(["deepseek-flash"]);

export function qoderModelsForRegion(region: QoderRegion): QoderModel[] {
  if (region === "cn") return QODER_MODELS.filter((m) => !CN_UNAVAILABLE.has(m.id));
  return QODER_MODELS.filter((m) => m.kind === "tier" || m.protocol === "new");
}

/**
 * Which protocol a region speaks for a model.
 *
 * The model keys are the same in both regions; only the wire format differs.
 */
export function qoderProtocolForRegion(model: QoderModel, region: QoderRegion): QoderProtocol {
  if (region === "cn") return "legacy";
  return model.protocol;
}

/** Context window and output cap, as the CLI advertises them. */
export const QODER_CONTEXT_WINDOW = 200000;
export const QODER_MAX_OUTPUT_TOKENS = 4096;

/** Largest context window any model in the catalog advertises. */
export const QODER_MAX_CONTEXT = 1000000;

const BY_ID = new Map(QODER_MODELS.map((m) => [m.id, m]));

export function getQoderModel(id: string): QoderModel | undefined {
  return BY_ID.get(id);
}

/**
 * The label a client sees: the model's name plus its credit multiplier, the
 * way the Qoder client shows it ("GLM-5.3 0.8×").
 */
export function qoderLabel(model: QoderModel): string {
  return model.multiplier ? `${model.name} ${model.multiplier}` : model.name;
}

/**
 * Resolve a client-visible id to what the gateway wants.
 *
 * A tier entry takes the thinking level from the request and turns it into the
 * tier the gateway knows. An unknown id is passed through unchanged: the
 * gateway rejects it with a clear message, which beats the proxy guessing.
 */
export function resolveModelRoute(
  id: string,
  effort?: string,
  region: QoderRegion = "global",
): { model: QoderModel | undefined; key: string } {
  const known = BY_ID.get(id);
  if (!known) return { model: undefined, key: id };
  if (known.kind === "tier") {
    // The CN catalog has no `ultimate`/`efficient` tier, so a tier request
    // there always lands on `auto`.
    if (region === "cn") return { model: known, key: known.key };
    return { model: known, key: known.tierFor?.(effort ?? "") ?? known.key };
  }
  return { model: known, key: known.key };
}

/** OpenAI GET /v1/models shape. */
export function openaiModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: QODER_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "qoder",
    })),
  };
}

/** Anthropic GET /v1/models shape, with the extra metadata pi reads. */
export function anthropicModelsPayload() {
  const data = QODER_MODELS.map((m) => ({
    id: m.id,
    type: "model",
    display_name: m.name,
    created_at: Math.floor(Date.now() / 1000),
    reasoning: m.reasoning,
    tool_call: true,
    context_window: m.context,
    max_output_tokens: QODER_MAX_OUTPUT_TOKENS,
    // Tiers accept a thinking level; a pinned model either thinks or does not,
    // and the list says which.
    ...(m.kind === "tier" ? { effort_options: [...QODER_EFFORTS] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
  }));
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
    default_model: DEFAULT_MODEL_ID,
  };
}
