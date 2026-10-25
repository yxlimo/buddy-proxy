// config-cli.ts — look at the settings, and change them.
//
// The settings live in the same database as the credentials. The environment
// still decides them when it says something; what is written here wins over
// the environment until it is cleared again.
//
//   node config-cli.ts list                 what the service will use
//   node config-cli.ts overrides            what the database holds
//   node config-cli.ts set KEY=VALUE        write one setting
//   node config-cli.ts clear KEY            forget an override
//   node config-cli.ts secrets              what credentials are configured
//
// The value is read the next time the service starts.

import { configClear, configOverride, configOverrides, configSnapshot, groupOf } from "./lib/config.ts";
import { closeStore, listSecrets } from "./lib/store.ts";

/** Print a value without handing out the whole secret. */
function mask(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-3)}`;
}

function list(): void {
  const snapshot = configSnapshot();
  const groups = new Map<string, typeof snapshot>();
  for (const s of snapshot) {
    const g = groups.get(s.group) ?? [];
    g.push(s);
    groups.set(s.group, g);
  }
  for (const [group, items] of [...groups].sort()) {
    console.log(`\n${group}`);
    for (const s of items) {
      const value = String(s.value);
      console.log(`  ${s.key.padEnd(38)} ${value.padEnd(28)} [${s.source}]`);
    }
  }
  console.log("");
}

function overrides(): void {
  const rows = configOverrides();
  if (!rows.length) {
    console.log("no overrides — the environment decides everything");
    return;
  }
  for (const r of rows) {
    console.log(`${r.key.padEnd(38)} ${r.value.padEnd(28)} [${new Date(r.updatedAt).toISOString()}]`);
  }
}

function secrets(): void {
  for (const row of listSecrets("")) {
    if (row.kind === "session") continue;
    const data = row.data ?? {};
    if (data && typeof data === "object" && "keys" in data) {
      console.log(`${row.id.padEnd(38)} ${Object.keys(data.keys as object).join(", ")}`);
      continue;
    }
    const parts: string[] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string" && v) parts.push(`${k}=${mask(v)}`);
      else if (v === null || v === undefined) parts.push(`${k}=—`);
      else parts.push(`${k}=${JSON.stringify(v)}`);
    }
    console.log(`${row.id.padEnd(38)} ${parts.join("  ")}`);
  }
}

function set(key: string, value: string): void {
  configOverride(key, value);
  console.log(`${key} = ${value}  (wins over the environment until it is cleared)`);
}

function clear(key: string): void {
  configClear(key);
  console.log(`${key} — the environment decides again`);
}

const [, , command, ...rest] = process.argv;
switch (command) {
  case "list":
    list();
    break;
  case "overrides":
    overrides();
    break;
  case "secrets":
    secrets();
    break;
  case "set": {
    const pair = rest[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      console.error("usage: node config-cli.ts set KEY=VALUE");
      process.exit(1);
    }
    set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    break;
  }
  case "clear":
    if (!rest[0]) {
      console.error("usage: node config-cli.ts clear KEY");
      process.exit(1);
    }
    clear(rest[0].trim());
    break;
  default:
    console.log(
      "usage:\n" +
        "  node config-cli.ts list           the settings the service will use\n" +
        "  node config-cli.ts overrides      what the database holds\n" +
        "  node config-cli.ts set KEY=VALUE  write one setting\n" +
        "  node config-cli.ts clear KEY      forget an override\n" +
        "  node config-cli.ts secrets        the credentials that are configured",
    );
    process.exit(command ? 1 : 0);
}

closeStore();
