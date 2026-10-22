// lib/config.ts — the settings, and where they come from.
//
// Three places, in this order:
//
//   1. the database  — what the management panel writes
//   2. the environment — what the deployment sets (process env, then .env)
//   3. the default in the code
//
// The service reads every setting once, at startup: the modules ask for their
// settings while they load, and the answers are cached from then on. A change
// in the database therefore takes effect on the next restart, not halfway
// through a request.
//
// The environment still wins for the things it is supposed to win for: the
// credentials (a rotated key in .env must not be shadowed by a stale copy in
// the database) and the paths that decide where the database itself is. Those
// are read through lib/env.ts and lib/store.ts, not through here.

import { parseBool, readEnvValue } from "./env.ts";
import { deleteConfig, getConfig, listConfig, setConfig } from "./store.ts";

/** Where the value of a setting came from. */
export type ConfigSource = "database" | "environment" | "default";

/** The kind of value a setting holds. */
export type ConfigType = "string" | "boolean" | "number";

/** One setting, as the service sees it. */
export interface Setting {
  key: string;
  type: ConfigType;
  /** The value in the code, when nothing else says otherwise. */
  fallback: string | number | boolean;
  /** The value in effect. */
  value: string | number | boolean;
  source: ConfigSource;
  /** Which panel the setting belongs to. */
  group: string;
}

/** Every setting the service has asked for, in the order it asked. */
const settings = new Map<string, Setting>();

/** The answers, cached: a setting is read once. */
const answers = new Map<string, { raw: string; source: ConfigSource }>();

/**
 * Which panel a setting belongs to.
 *
 * The name of the setting says it — the prefix is the upstream it is about.
 */
export function groupOf(key: string): string {
  if (key.startsWith("MINIMAX_")) return "minimax";
  if (key.startsWith("QODER_")) return "qoder";
  if (key.startsWith("WORKBUDDY_")) return "workbuddy";
  if (key.startsWith("TOKENRHYTHM_") || key.startsWith("TOKEN_RHYTHM_")) return "tokenrhythm";
  if (key.startsWith("ROUTER_") || key.startsWith("HEALTH_") || key.startsWith("REQUIRE_")) return "gateway";
  if (key.startsWith("BENEFITS_")) return "benefits";
  return "general";
}

/** The raw value of a setting, and where it came from. */
function resolve(key: string, fallback: string | number | boolean): { raw: string; source: ConfigSource } {
  const cached = answers.get(key);
  if (cached) return cached;

  let raw: string;
  let source: ConfigSource;
  const fromDb = getConfig(key);
  if (fromDb !== null) {
    raw = fromDb;
    source = "database";
  } else {
    const fromEnv = readEnvValue(key);
    if (fromEnv !== null) {
      raw = fromEnv;
      source = "environment";
    } else {
      raw = String(fallback);
      source = "default";
    }
  }
  answers.set(key, { raw, source });
  return { raw, source };
}

/** Remember the setting, so the snapshot and the panel know about it. */
function remember(key: string, type: ConfigType, fallback: string | number | boolean): void {
  if (settings.has(key)) return;
  settings.set(key, { key, type, fallback, value: fallback, source: "default", group: groupOf(key) });
}

/** A setting as a string. */
export function configString(key: string, fallback: string): string {
  remember(key, "string", fallback);
  const { raw, source } = resolve(key, fallback);
  settings.get(key)!.value = raw;
  settings.get(key)!.source = source;
  return raw;
}

/** A setting as a flag. Anything that is not a yes or a no falls back. */
export function configFlag(key: string, fallback: boolean): boolean {
  remember(key, "boolean", fallback);
  const { raw, source } = resolve(key, fallback);
  const parsed = parseBool(raw);
  const value = parsed ?? fallback;
  settings.get(key)!.value = value;
  settings.get(key)!.source = source;
  return value;
}

/** A setting as a number. Anything that is not a number falls back. */
export function configNumber(key: string, fallback: number): number {
  remember(key, "number", fallback);
  const { raw, source } = resolve(key, fallback);
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  settings.get(key)!.value = value;
  settings.get(key)!.source = source;
  return value;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Write a setting to the database.
 *
 * It wins over the environment from now on, until it is cleared again.
 */
export function configOverride(key: string, value: string): void {
  setConfig(key, value);
  answers.delete(key);
  const setting = settings.get(key);
  if (setting) {
    setting.source = "database";
    setting.value = setting.type === "boolean" ? (parseBool(value) ?? setting.fallback) : value;
  }
}

/** Forget an override: the environment says again. */
export function configClear(key: string): void {
  deleteConfig(key);
  answers.delete(key);
  const setting = settings.get(key);
  if (setting) {
    setting.source = "default";
    setting.value = setting.fallback;
  }
}

/**
 * Read the settings again.
 *
 * The service does not poll the database; a change waits until someone asks
 * for it to be picked up. This is that ask: the panel calls it after writing,
 * and the next request sees the new value.
 */
export function reloadConfig(): number {
  answers.clear();
  let count = 0;
  for (const setting of settings.values()) {
    // Ask again through the same path, so the source is recorded the same way.
    switch (setting.type) {
      case "boolean":
        configFlag(setting.key, Boolean(setting.fallback));
        break;
      case "number":
        configNumber(setting.key, Number(setting.fallback));
        break;
      default:
        configString(setting.key, String(setting.fallback));
        break;
    }
    count++;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Looking at it
 * ------------------------------------------------------------------ */

/** Every setting the service asked for, with its value and its source. */
export function configSnapshot(): Setting[] {
  return [...settings.values()].map((s) => ({ ...s }));
}

/** The settings that are written in the database, and nothing else. */
export function configOverrides(): { key: string; value: string; updatedAt: number }[] {
  return listConfig();
}

/**
 * Log the settings that are not the default, and say where the rest came from.
 *
 * This is what makes a setting change visible: an override in the database
 * shows up here with its source, next to the ones the deployment set.
 */
export function logConfig(): void {
  const snapshot = configSnapshot();
  const changed = snapshot.filter((s) => s.source !== "default");
  const bySource = snapshot.reduce<Record<string, number>>((acc, s) => {
    acc[s.source] = (acc[s.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[CONFIG] ${snapshot.length} settings (${bySource.database ?? 0} from the database, ` +
      `${bySource.environment ?? 0} from the environment, ${bySource.default ?? 0} default)`,
  );
  for (const s of changed) {
    console.log(`[CONFIG] ${s.key} = ${s.value}  [${s.source}]`);
  }
}
