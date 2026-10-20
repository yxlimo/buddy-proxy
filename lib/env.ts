// lib/env.ts — the shared, whitelist-only `.env` reader for every proxy here.
//
// Only the keys passed to readEnvValue / readEnvFlag are ever parsed from `.env`;
// secrets in the same file are never loaded, logged, or exported into the process
// environment. Precedence: process environment > .env file > fallback.
//
// The whole repo reads `.env` one way through this.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = path.join(HERE, "..", ".env");

/** Parse a boolean-ish value. Returns null for unset/unrecognized. */
export function parseBool(raw: string | undefined | null): boolean | null {
  if (raw === undefined || raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

/**
 * Read one whitelisted key: environment variable wins over the file. Only the
 * requested `key` is parsed — every other line (secrets) is ignored.
 */
export function readEnvValue(key: string): string | null {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || m[1] !== key) continue; // whitelist: ignore every other key
      return m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env */
  }
  return null;
}

export function readEnvFlag(key: string, fallback: boolean): boolean {
  return parseBool(process.env[key]) ?? parseBool(readEnvValue(key)) ?? fallback;
}

export function readEnvNumber(key: string, fallback: number): number {
  const raw = readEnvValue(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function readEnvString(key: string, fallback: string): string {
  return readEnvValue(key) ?? fallback;
}
