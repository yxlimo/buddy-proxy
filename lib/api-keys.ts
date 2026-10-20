// lib/api-keys.ts — the shared front-door API-key check for every proxy here.
//
// Same scheme as v1-proxy.mjs / v2-proxy.ts: a flat name→key map in
// api-keys.json, generated on first startup if empty. Default is public mode
// (any key, or none, passes) because the upstream free tier is gated by the
// client's own login, not by a client-supplied key. `REQUIRE_API_KEY=true`
// turns the front door on for every proxy in the repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFlag, readEnvString } from "./env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REQUIRE_API_KEY = readEnvFlag("REQUIRE_API_KEY", false);
export const KEYS_FILE = readEnvString("KEYS_FILE", path.join(HERE, "..", "api-keys.json"));

export type KeyStore = Record<string, string>;

/** Load api-keys.json, generating one when it is missing or empty. */
export function loadKeys(prefix = "oc-"): KeyStore {
  let keys: KeyStore = {};
  try {
    keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    keys = {};
  }
  if (Object.keys(keys).length === 0) {
    keys = {
      admin: prefix + crypto.randomBytes(20).toString("hex"),
      "user-default": prefix + crypto.randomBytes(20).toString("hex"),
    };
    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
      console.log("[INIT] Generated new API keys →", KEYS_FILE);
    } catch {
      // The container image runs as a non-root user with a read-only app directory,
      // so the keys can only live in memory. Point KEYS_FILE at a writable volume
      // (e.g. /data/api-keys.json) to make them survive restarts.
      console.warn(`[INIT] Generated API keys for this run only (cannot write ${KEYS_FILE}); they change on restart`);
    }
  }
  return keys;
}

/** Bearer token, x-api-key header, or raw Authorization header. */
export function extractToken(req: { headers: Record<string, unknown> }): string {
  const hdr: string = (req.headers.authorization as string) || (req.headers["x-api-key"] as string) || "";
  return hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
}

/** Returns the key name, or null when a required key is missing/unknown. */
export function authenticate(req: { headers: Record<string, unknown> }, keys: KeyStore): string | null {
  const tok = extractToken(req);
  // Public mode (default): accept anything, even a blank token.
  if (!REQUIRE_API_KEY) return "public";
  for (const [name, key] of Object.entries(keys)) if (tok === key) return name;
  return null;
}
