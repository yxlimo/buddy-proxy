#!/usr/bin/env node
/**
 * Decrypt a Qoder CLI model catalog (catalog-vN) using the official client's
 * own WASM crypto module (qoder_auth_wasm) extracted from ~/.qodersec/bin/qodercli.
 *
 * Usage: node decrypt.js <catalog-file> <uid> [outfile]
 */
const fs = require('node:fs');
const path = require('node:path');
const { kjB, ub0, yb0, pb0init } = require('./qoder_wasm_glue.cjs');

const WASM = path.join(__dirname, 'qoder_auth_wasm.wasm');

function initWasm() {
  pb0init();
  const bytes = fs.readFileSync(WASM);
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, ub0());
  yb0(inst, mod);
  return inst;
}

function main() {
  const [catalogFile, uid, outfile] = process.argv.slice(2);
  if (!catalogFile || !uid) {
    console.error('usage: node decrypt.js <catalog-file> <uid> [outfile]');
    process.exit(2);
  }
  initWasm();
  const text = fs.readFileSync(catalogFile, 'utf-8');
  console.error(`[*] catalog=${catalogFile} (${text.length} chars) uid=${uid}`);
  let plain;
  try {
    plain = kjB(text, uid);
  } catch (e) {
    console.error('[-] decrypt failed:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
  console.error(`[+] decrypted ${plain.length} chars`);
  if (outfile) {
    fs.writeFileSync(outfile, plain);
    console.error(`[+] written -> ${outfile}`);
  } else {
    process.stdout.write(plain);
  }
}

main();
