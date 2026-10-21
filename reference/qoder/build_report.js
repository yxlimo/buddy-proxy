#!/usr/bin/env node
/**
 * Build the final Qoder CLI model-catalog report.
 *
 *   node build_report.js <catalog-file> <uid> <out.json>
 *
 * Decrypts the catalog with the official client's own WASM crypto module
 * (qoder_auth_wasm, extracted from ~/.qodersec/bin/qodercli) and extracts the
 * per-model token limits.
 *
 * ── What "max_output_tokens" means for Qoder ────────────────────────────────
 * The raw catalog NEVER carries a `max_output_tokens` field (verified for
 * catalog-v6 and catalog-v7: the string does not occur once). The client
 * resolves it with its own helper:
 *
 *     function Ob(A){                       // qodercli bundle
 *       let H = typeof A==="number" ? A
 *             : typeof A==="string" && A.trim().length>0 ? Number(A)
 *             : Number.NaN;
 *       return Number.isSafeInteger(H) && H>0 ? H : 32000;
 *     }
 *
 * and `parseModelList` does `max_output_tokens: Ob(w.max_output_tokens)`, so
 * every model ends up with 32000. `S4A` then puts it on the wire:
 *
 *     if (f?.maxOutputTokens !== void 0) g.max_tokens = Ob(f.maxOutputTokens);
 *     else if (g.max_tokens === void 0)  g.max_tokens = Ob(M);   // M = 32000
 *
 * Independently confirmed on the wire: a captured request to
 *   POST /algo/api/v2/service/pro/sse/agent_chat_generation?…&Encode=1
 * decoded (see decode_legacy_body.js) to
 *   "parameters": { "max_tokens": 32000 }
 */
const fs = require('node:fs');
const path = require('node:path');
const { kjB, ub0, yb0, pb0init } = require('./qoder_wasm_glue.cjs');

const WASM = path.join(__dirname, 'qoder_auth_wasm.wasm');
// client-side fallback inside `Ob()` (and `$b$` for byok/external providers)
const CLIENT_DEFAULT_MAX_OUTPUT = 32000;

function initWasm() {
  pb0init();
  const mod = new WebAssembly.Module(fs.readFileSync(WASM));
  const inst = new WebAssembly.Instance(mod, ub0());
  yb0(inst, mod);
}

/** Reproduce the client's `Ob()` helper. */
function Ob(v) {
  const n =
    typeof v === 'number' ? v :
    typeof v === 'string' && v.trim().length > 0 ? Number(v) :
    NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : CLIENT_DEFAULT_MAX_OUTPUT;
}

function main() {
  const [catalogFile, uid, outFile] = process.argv.slice(2);
  if (!catalogFile || !uid) {
    console.error('usage: node build_report.js <catalog-file> <uid> <out.json>');
    process.exit(2);
  }
  initWasm();

  const text = fs.readFileSync(catalogFile, 'utf-8');
  const plain = kjB(text, uid);          // WASM model_cache_decrypt(fileText, uid)
  const data = JSON.parse(plain);

  // ---- collect every model across every scene -----------------------------
  const models = {};
  const sceneOrder = [];
  const rawHasMaxOutput = /"max_output_tokens"/.test(plain);

  for (const [scene, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    sceneOrder.push(scene);
    for (const raw of list) {
      const key = String(raw.key ?? raw.model_key ?? '');
      if (!key) continue;
      if (!models[key]) {
        models[key] = {
          key,
          display_name: raw.display_name ?? raw.name ?? null,
          // raw catalog field — absent for every model -> null
          max_output_tokens: raw.max_output_tokens ?? null,
          // what the client actually resolves and sends
          effective_max_output_tokens: Ob(raw.max_output_tokens),
          max_input_tokens: raw.max_input_tokens ?? null,
          max_input_tokens_variants: [],
          format: raw.format ?? null,
          source: raw.source ?? null,
          is_reasoning: raw.is_reasoning ?? null,
          is_vl: raw.is_vl ?? null,
          is_default: raw.is_default ?? null,
          scenes: [],
        };
      }
      models[key].scenes.push(scene);
      if (raw.max_input_tokens != null) {
        models[key].max_input_tokens_variants.push(raw.max_input_tokens);
      }
    }
  }
  for (const m of Object.values(models)) {
    m.max_input_tokens_variants = [...new Set(m.max_input_tokens_variants)];
  }

  const report = {
    uid,
    source: path.basename(catalogFile),
    decrypted_bytes: plain.length,
    client_default_max_output_tokens: CLIENT_DEFAULT_MAX_OUTPUT,
    raw_catalog_contains_max_output_tokens: rawHasMaxOutput,
    notes: [
      'The raw catalog contains NO `max_output_tokens` field for any model.',
      'The client resolves it via Ob(v) -> v if a safe positive integer, else 32000.',
      'parseModelList(): max_output_tokens: Ob(w.max_output_tokens)  => 32000 for all models.',
      'S4A() puts it on the wire: g.max_tokens = Ob(defaultMaxOutputTokens).',
      'Wire-confirmed: a captured /algo/api/v2/service/pro/sse/agent_chat_generation',
      'request decodes to "parameters": { "max_tokens": 32000 }.',
      '=> max_output_tokens is 32000 for EVERY model; there are no exceptions.',
    ],
    scenes: sceneOrder,
    models,
  };

  // merge the wire-capture evidence if it was collected
  const wireFile = path.join(__dirname, '..', 'qoder-wire-capture.json');
  if (fs.existsSync(wireFile)) {
    try {
      const wire = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
      report.wire_capture = {
        ...wire,
        note: 'parameters.max_tokens is what the official client puts on the wire',
      };
    } catch { /* ignore */ }
  }

  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  // ---- console table -------------------------------------------------------
  const rows = Object.values(models).sort((a, b) => a.key.localeCompare(b.key));
  console.log(`\nuid=${uid}  source=${report.source}  models=${rows.length}`);
  console.log('-'.repeat(100));
  console.log(
    'model key'.padEnd(30) + 'display_name'.padEnd(24) +
    'max_output_tokens(raw)'.padEnd(24) + 'effective'.padEnd(12) +
    'max_input_tokens'.padEnd(18) + 'scenes');
  console.log('-'.repeat(100));
  for (const m of rows) {
    console.log(
      m.key.padEnd(30) + String(m.display_name ?? '').padEnd(24) +
      String(m.max_output_tokens ?? 'null (absent)').padEnd(24) +
      String(m.effective_max_output_tokens).padEnd(12) +
      String(m.max_input_tokens ?? 'null').padEnd(18) +
      m.scenes.join(','));
  }
  console.log('-'.repeat(100));
  console.log(`distinct raw max_output_tokens : ${[...new Set(rows.map(m => m.max_output_tokens))].map(v => v ?? 'null(absent)').join(', ')}`);
  console.log(`distinct effective max_output   : ${[...new Set(rows.map(m => m.effective_max_output_tokens))].join(', ')}`);
  const multi = rows.filter(m => m.max_input_tokens_variants.length > 1);
  if (multi.length) {
    console.log(`max_input_tokens varies by scene : ${multi.map(m => `${m.key}=[${m.max_input_tokens_variants.join(',')}]`).join(' ')}`);
  }
  const noCtx = rows.filter(m => m.max_input_tokens == null);
  if (noCtx.length) {
    console.log(`no max_input_tokens in catalog  : ${noCtx.map(m => m.key).join(', ')} (client falls back to 200000 in GmE(), but parseModelList stores 0)`);
  }
  if (outFile) console.log(`\nreport -> ${outFile}`);
}

main();
