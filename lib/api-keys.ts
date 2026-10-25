// lib/api-keys.ts — the shared front-door API-key check for every proxy here.
//
// The keys live in the database (the secrets table, under `keys:clients`).
// api-keys.json is only the fallback: it is read once, when the database has
// no keys yet, so a fresh install without the file just gets a new pair.
//
// Default is public mode (any key, or none, passes) because the upstream free
// tier is gated by the client's own login, not by a client-supplied key.
// `REQUIRE_API_KEY=true` turns the front door on for every proxy in the repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFlag, markHotSetting } from "./config.ts";
import { readEnvValue } from "./env.ts";
import { getSecret, setSecret } from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The front door is checked on every request, so the switch is hot: the panel
// turns it on and the next request meets the locked door.
markHotSetting("REQUIRE_API_KEY");

// Ask for it here, at load time: a setting nobody has asked for is not in the
// snapshot, so the panel would not show it and config-cli would refuse to
// write it. The value itself is read again on every request.
configFlag("REQUIRE_API_KEY", false);

/** Does the front door need a key? The value in use right now. */
export function requireApiKey(): boolean {
  return configFlag("REQUIRE_API_KEY", false);
}

// The file the keys used to live in. It is only read once, when the database
// has no keys yet, so it stays a path the deployment decides.
export const KEYS_FILE = readEnvValue("KEYS_FILE") || path.join(HERE, "..", "api-keys.json");

export type KeyStore = Record<string, string>;

/** Where the agents' keys are kept. */
const KEYS_ID = "keys:clients";

/** Load the agents' keys, generating one set when there are none. */
export function loadKeys(prefix = "oc-"): KeyStore {
  let keys: KeyStore = {};
  const stored = getSecret<{ keys: KeyStore }>(KEYS_ID);
  if (stored?.keys && typeof stored.keys === "object") {
    keys = stored.keys;
  } else {
    // The file the keys used to live in.
    try {
      const fromFile = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
      if (fromFile && typeof fromFile === "object") keys = fromFile;
    } catch {
      keys = {};
    }
  }
  if (Object.keys(keys).length === 0) {
    keys = {
      admin: prefix + crypto.randomBytes(20).toString("hex"),
      "user-default": prefix + crypto.randomBytes(20).toString("hex"),
    };
    setSecret(KEYS_ID, "key", { keys });
    console.log("[INIT] Generated new API keys → the database");
  }
  return keys;
}

/** Bearer token, x-api-key header, or raw Authorization header. */
export function extractToken(headers: Record<string, unknown>): string {
  const hdr: string = (headers.authorization as string) || (headers["x-api-key"] as string) || "";
  return hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
}

/** Returns the key name, or null when a required key is missing/unknown. */
export function authenticate(headers: Record<string, unknown>, keys: KeyStore): string | null {
  const tok = extractToken(headers);
  // Public mode (default): accept anything, even a blank token.
  if (!requireApiKey()) return "public";
  for (const [name, key] of Object.entries(keys)) if (tok === key) return name;
  return null;
}
