// free-features.ts — Free-model filtering, local snapshot, whitelist .env loader.
//
// Ported from the opencode-zen-proxy Python implementation so both proxies
// share the same behavior:
//
//   1. `OPENCODE_ZEN_PROXY_SHOW_FREE=true` — when set, GET /v1/models only
//      returns model ids containing the `free` keyword (case-insensitive).
//   2. `REQUIRE_API_KEY=true` — when set, every request must present a valid
//      key from api-keys.json. Default (off) is public mode: any API key (or
//      none at all) is accepted, since ZEN free access is gated by the
//      opencode binary's own login, not by a client-supplied key.
//   3. On first startup the model listing is snapshotted to free_models.json
//      (atomic write) in Anthropic `GET /v1/models` shape:
//      { updated_at, source, count, data[], has_more, first_id, last_id }.
//   4. `.env` is read line-by-line but ONLY the whitelisted flag keys above
//      are parsed — secrets in the same file are never loaded or logged.
//      The reader itself lives in lib/env.ts, shared with the other proxies.
//
// Precedence: process environment > .env file > default (off).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFlag } from "./lib/env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SHOW_FREE_ENV = "OPENCODE_ZEN_PROXY_SHOW_FREE";
export const REQUIRE_API_KEY_ENV = "REQUIRE_API_KEY";
export const FREE_KEYWORD = "free";

/**
 * Resolve SHOW_FREE without ever loading the rest of `.env`.
 * Environment variable wins over the file; unknown/absent → false.
 */
export function loadShowFree(): boolean {
  return readEnvFlag(SHOW_FREE_ENV, false);
}

/**
 * Resolve REQUIRE_API_KEY: when false (default) the proxy is public — any
 * API key (or none) is accepted. When true, requests must present one of the
 * keys in api-keys.json. ZEN free access itself is gated by the opencode
 * binary's own login, so this is purely an optional front-door check.
 */
export function loadRequireApiKey(): boolean {
  return readEnvFlag(REQUIRE_API_KEY_ENV, false);
}

/** Keep only ids containing the free keyword (case-insensitive). */
export function filterFreeModels(ids: string[]): string[] {
  const kw = FREE_KEYWORD.toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(kw));
}

/** Local timestamp like 2026-10-13T18:25:04+0800 */
function localStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** One model, saved in full: id + display_name + both API shapes + raw ZEN entry. */
export type ModelSnapshotEntry = {
  id: string;
  display_name: string;
  openai: Record<string, unknown>;
  anthropic: Record<string, unknown>;
  zen_raw: Record<string, unknown>;
};

/**
 * Atomically snapshot the model listing to free_models.json — each entry keeps
 * the id, display_name, the OpenAI-shaped object, the Anthropic-shaped object,
 * and the raw opencode (/api/model) entry verbatim. Failures are reported but
 * never fatal (the listing itself already succeeded).
 */
export function saveFreeModels(
  models: ModelSnapshotEntry[],
  source: string,
  file = path.join(HERE, "free_models.json"),
): void {
  const payload = {
    updated_at: localStamp(),
    source,
    count: models.length,
    models,
  };
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    console.log("[free] snapshot write failed:", (e as Error).message);
  }
}
