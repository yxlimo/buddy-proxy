#!/usr/bin/env node
/**
 * Decode every captured Qoder infer request and report the wire `max_tokens`
 * per model key (attributed by the body's own model_config.key).
 *
 *   node decode_sweep.js <glob-dir> <file-prefix>
 */
const fs = require('node:fs');
const path = require('node:path');
const { qoderBase64Decode } = require('./decode_legacy_body.js');

const dir = process.argv[2] || '/tmp/opencode/mitm';
const prefix = process.argv[3] || 'sweep-';

const best = new Map();   // model key -> {len, body}
let files = 0, reqs = 0;

for (const f of fs.readdirSync(dir)) {
  if (!f.startsWith(prefix) || !f.endsWith('.jsonl')) continue;
  files++;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.t !== 'request' || o.method !== 'POST') continue;
    if (!String(o.path || '').includes('agent_chat_generation')) continue;
    reqs++;
    let j;
    try { j = JSON.parse(qoderBase64Decode(o.body).toString('utf8')); } catch { continue; }
    const k = j.model_config?.key;
    if (!k) continue;
    const prev = best.get(k);
    if (!prev || o.body.length > prev.len) best.set(k, { len: o.body.length, j });
  }
}

console.log(`files=${files} infer-requests=${reqs} distinct-models=${best.size}\n`);
console.log('model key'.padEnd(20) + 'wire max_tokens'.padEnd(20) +
  'model_config.max_input_tokens'.padEnd(32) + 'catalog max_input_tokens');
const catalog = JSON.parse(fs.readFileSync('/tmp/opencode/qoder-catalog-decrypted.json', 'utf8')).models;
for (const [k, v] of [...best].sort((a, b) => a[0].localeCompare(b[0]))) {
  const cat = catalog[k];
  console.log(
    k.padEnd(20) +
    String(v.j.parameters?.max_tokens).padEnd(20) +
    String(v.j.model_config?.max_input_tokens).padEnd(32) +
    String(cat ? cat.max_input_tokens : 'n/a'));
}
const vals = new Set([...best.values()].map(v => v.j.parameters?.max_tokens));
console.log(`\ndistinct wire max_tokens across all captured models: ${[...vals].join(', ')}`);
