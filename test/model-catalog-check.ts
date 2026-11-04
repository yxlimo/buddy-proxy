// test/model-catalog-check.ts — the external vendors' catalogue that ships with the repo.
//
//   node --experimental-strip-types test/model-catalog-check.ts
//
// Offline: reads lib/model-catalog.json, no upstream, no request, no tokens.
//
// The file lists the models of the vendors this repo has no code for (deepseek,
// nvidia, opencode zen), keyed by host. Three things have to hold forever:
//
//   1. it only ever describes outsiders: the vendors this repo implements itself
//      are described by their own code, so a key for one of them would be a
//      second copy of the same fact, and the two copies will drift
//   2. it stays a well-formed catalogue: every key is a host, every key has a
//      non-empty list of models, every model has an id, no id twice under one key
//   3. nothing from the configs leaks into it. Those configs carry real API
//      keys, an Authorization header, and the gateway's address — none of that
//      may end up in a file that is committed

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "lib", "model-catalog.json");

interface Model {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  reasoning?: unknown;
  toolCall?: unknown;
}

interface Entry {
  source?: unknown;
  models?: unknown;
}

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Read it the way the loader would: the raw bytes are what gets committed, so
// the privacy check below has to look at the bytes, not at a parsed object.
const text = fs.readFileSync(FILE, "utf8");
const raw: unknown = JSON.parse(text);

console.log("");
console.log("the file parses and has the shape it promises");

check("it is a JSON object", !!raw && typeof raw === "object" && !Array.isArray(raw));
const table = raw as Record<string, Entry>;
const keys = Object.keys(table);
check("it has keys", keys.length > 0, JSON.stringify(keys));

// A host: has a dot, no protocol, no path. `api.deepseek.com` passes,
// `deepseek`, `https://api.deepseek.com/v1` and `api.deepseek.com/v1` do not.
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
for (const key of keys) {
  check(`${key}: the key is a host name`, HOST.test(key), key);
  check(`${key}: the key carries no protocol`, !key.includes("://") && !key.includes("/"), key);
}

// The vendors this repo implements itself. Their models come from their own
// modules; a key here would be a second source of truth for the same thing.
// `qoder-cn` and `workbuddy-cn` are platform ids rather than kinds, and `buddy`
// was the gateway's own routing table — none of them belongs in a vendor list.
const ours = [
  "qoder",
  "qoder-cn",
  "workbuddy",
  "workbuddy-cn",
  "minimax",
  "zcode",
  "sensenova",
  "intern-ai",
  "tokenrhythm",
  "qiniu",
  "xinghuo",
  "buddy",
];
const doubled = ours.filter((name) => name in table);
check("no vendor this repo implements itself has a key", doubled.length === 0, doubled.join(", "));

// A host-shaped key is not enough: the host itself must not be one of ours.
const ourHosts = ours.filter((name) => keys.some((key) => key === name || key.startsWith(`${name}.`)));
check("and no host belongs to one of them", ourHosts.length === 0, ourHosts.join(", "));

for (const key of keys) {
  const entry = table[key] ?? {};
  const models = Array.isArray(entry.models) ? (entry.models as Model[]) : null;
  check(`${key}: models is a non-empty list`, !!models && models.length > 0);
  check(
    `${key}: source names where the data came from`,
    Array.isArray(entry.source) &&
      entry.source.length > 0 &&
      entry.source.every((s) => typeof s === "string" && s !== ""),
    JSON.stringify(entry.source),
  );

  const ids = (models ?? []).map((m) => m?.id);
  check(
    `${key}: every model has a string id`,
    ids.every((id) => typeof id === "string" && id !== ""),
    JSON.stringify(ids.filter((id) => typeof id !== "string" || id === "")),
  );
  check(
    `${key}: no id twice`,
    new Set(ids).size === ids.length,
    JSON.stringify(ids.filter((id, i) => ids.indexOf(id) !== i)),
  );

  // A field that is there but empty is an assertion with no evidence: the
  // convention is "the key is absent when the value is unknown".
  const numbers = (models ?? []).flatMap((m) => [m?.contextWindow, m?.maxOutputTokens]);
  check(
    `${key}: the numbers are positive when present`,
    numbers.every((n) => n === undefined || (typeof n === "number" && n > 0)),
    JSON.stringify(numbers.filter((n) => n !== undefined && (typeof n !== "number" || !(n > 0)))),
  );
  const bools = (models ?? []).flatMap((m) => [m?.reasoning, m?.toolCall]);
  check(
    `${key}: the flags are booleans when present`,
    bools.every((b) => b === undefined || typeof b === "boolean"),
    JSON.stringify(bools.filter((b) => b !== undefined && typeof b !== "boolean")),
  );
}

console.log("");
console.log("the reader answers by host, and says null when it does not know");

const { knownCatalogForBaseUrl, knownModelForBaseUrl } = await import("../lib/model-catalog.ts");

const deepseek = "https://api.deepseek.com";
const catalogue = knownCatalogForBaseUrl(`${deepseek}/v1`);
check("deepseek has a catalogue", !!catalogue && catalogue.models.length > 0);
check(
  "and it is the one in the file",
  JSON.stringify(catalogue) === JSON.stringify(table["api.deepseek.com"]),
);

// The same vendor, spelled the ways a config may spell it: a port, another
// case, http. A lookup that misses any of these drops the catalogue silently.
check("a port does not hide it", !!knownCatalogForBaseUrl("https://api.deepseek.com:443/v1"));
check(
  "a port of its own does not hide it",
  !!knownCatalogForBaseUrl("http://api.deepseek.com:8080/v1"),
);
check("the case of the host does not hide it", !!knownCatalogForBaseUrl("https://API.DeepSeek.COM/v1"));
check("plain http does not hide it", !!knownCatalogForBaseUrl("http://api.deepseek.com/v1"));

check("an unknown vendor is null", knownCatalogForBaseUrl("https://no-such.example/v1") === null);
check("a URL that does not parse is null", knownCatalogForBaseUrl("not a url") === null);
check("an empty string is null", knownCatalogForBaseUrl("") === null);
check("a host with no protocol is null", knownCatalogForBaseUrl("api.deepseek.com") === null);
check("another protocol is null", knownCatalogForBaseUrl("file://api.deepseek.com/v1") === null);

// An id that really is in there, read from the file rather than hard-coded:
// the catalogue will be regenerated, and the check should not rot with it.
const firstModel = (table["api.deepseek.com"]?.models as Model[] | undefined)?.[0];
const sampleId = typeof firstModel?.id === "string" ? firstModel.id : "";
check("deepseek has a first model to look up", sampleId !== "");
const sample = knownModelForBaseUrl(`${deepseek}/v1`, sampleId);
check(`deepseek knows ${sampleId}`, !!sample && sample.id === sampleId, JSON.stringify(sample));
check("and the lookup returns the same fields the file has", JSON.stringify(sample) === JSON.stringify(firstModel));

check("an unknown vendor is null for a model lookup too", knownModelForBaseUrl("https://no-such.example/v1", sampleId) === null);
check("an unknown model is null", knownModelForBaseUrl(`${deepseek}/v1`, "no-such-model") === null);
check("a URL that does not parse is null for a model lookup too", knownModelForBaseUrl("not a url", sampleId) === null);

// The upstream's model names are case sensitive (ZCode accepts only the
// lowercase `glm-5.3`), so the lookup must not fold case.
check(
  "the model lookup does not fold case",
  knownModelForBaseUrl(`${deepseek}/v1`, sampleId.toUpperCase()) === null || sampleId.toUpperCase() === sampleId,
  sampleId,
);

console.log("");
console.log("nothing from the clients' configs leaked into it");

// The point of the check: those files carry live credentials and the gateway's
// own address. Anything of that shape in the committed catalogue is a leak, not
// a formatting problem. Scanning `text` — the bytes on disk — rather than the
// parsed object is deliberate: a leak sitting in a key or in the formatting is
// invisible to a walk over the object, but the file still ships.
const forbidden = [
  { what: "an API key (sk-)", needle: "sk-" },
  { what: "an apiKey field", needle: "apiKey" },
  { what: "an Authorization header", needle: "Authorization" },
  { what: "a bearer token", needle: "Bearer" },
  { what: "a cookie", needle: "cookie" },
  { what: "the gateway's LAN address", needle: "192.168." },
  { what: "the gateway's port", needle: ":6450" },
  { what: "a loopback address", needle: "127.0.0.1" },
  { what: "a headers block", needle: 'headers"' },
  { what: "a base URL field", needle: "baseUrl" },
  { what: "a settings block", needle: "settings" },
];
for (const { what, needle } of forbidden) {
  const at = text.indexOf(needle);
  check(`it holds no trace of ${what}`, at < 0, at < 0 ? "" : `found ${needle} at byte ${at}`);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const email = EMAIL.exec(text);
check("it holds no e-mail address", email === null, email?.[0] ?? "");

// A credential does not need a `sk-` prefix to be a credential: a 40-character
// blob of token characters is what one looks like. Hosts, ids and names are the
// only long strings allowed — `integrate.api.nvidia.com` is itself 24 characters
// — so every other long run is a finding.
const values = [...keys];
for (const key of keys) {
  for (const model of (table[key]?.models as Model[]) ?? []) {
    if (typeof model?.id === "string") values.push(model.id);
    if (typeof model?.name === "string") values.push(model.name);
  }
}
const RUN = /[A-Za-z0-9_+=/.-]{24,}/g;
const runs = text.match(RUN) ?? [];
const unexplained = runs.filter((run) => !values.some((value) => value.includes(run)));
check("every long token run is a model id or name", unexplained.length === 0, unexplained.join(", "));
check("and the scan did look at something", runs.length > 0, String(runs.length));

// The field whitelist, spelled out: a model may carry these keys and no other.
// A new field is fine, but it has to be a decision, so the list is compared
// rather than "not obviously a secret".
const allowed = new Set(["id", "name", "contextWindow", "maxOutputTokens", "reasoning", "toolCall"]);
const extra: string[] = [];
for (const key of keys) {
  for (const model of (table[key]?.models as Model[]) ?? []) {
    for (const field of Object.keys(model ?? {})) if (!allowed.has(field)) extra.push(`${key}.${String(model.id)}.${field}`);
  }
}
check("every model carries only the catalogued fields", extra.length === 0, extra.join(", "));

// `reasoning` here means "the model itself thinks", not "the entry point has a
// thinking toggle". The clients' configs only say the latter, so the flag may
// only be set where the model's own name says it reasons — a `false` from the
// configs is "unknown", never an assertion, and must not appear at all.
const claimed = keys.flatMap((key) =>
  ((table[key]?.models as Model[]) ?? [])
    .filter((m) => m?.reasoning !== undefined)
    .map((m) => ({ id: String(m.id), reasoning: m.reasoning, name: String(m.name ?? "") })),
);
const unsupported = claimed.filter(
  (m) => m.reasoning !== true || !/reason/i.test(m.id) && !/reason/i.test(m.name),
);
check(
  "a reasoning flag only sits on a model whose own name says it reasons",
  unsupported.length === 0,
  JSON.stringify(unsupported),
);

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
