#!/usr/bin/env node
/**
 * Decoder for Qoder's legacy ("algo/api/v2/service/pro/sse/agent_chat_generation")
 * request body encoding.
 *
 * Encoding (as implemented by the official CLI's WASM `prepareInferRequest`):
 *   1. plain JSON -> standard base64
 *   2. the base64 string is rearranged in thirds:
 *        rearranged = std.slice(-split) + std.slice(split, -split) + std.slice(0, split)
 *        with split = floor(std.length / 3)
 *   3. every char is mapped through the custom alphabet
 *        (standard base64 alphabet -> Qoder alphabet, '=' -> '$')
 *
 * This file is the inverse of that transform.
 */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const TO_CUSTOM = new Map();
const TO_STD = new Map();
for (let i = 0; i < STD_ALPHABET.length; i++) {
  TO_CUSTOM.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
  TO_STD.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
}
TO_CUSTOM.set('=', '$');
TO_STD.set('$', '=');

function qoderBase64Decode(text) {
  let std = '';
  for (const ch of text) std += TO_STD.get(ch) ?? ch;
  const len = std.length;
  const split = Math.floor(len / 3);
  const A = std.slice(0, split);                 // was the tail
  const B = std.slice(split, len - split);        // was the middle
  const C = std.slice(len - split);              // was the head
  const original = C + B + A;
  return Buffer.from(original, 'base64');
}

module.exports = { qoderBase64Decode, CUSTOM_ALPHABET, STD_ALPHABET };

if (require.main === module) {
  const fs = require('node:fs');
  const input = fs.readFileSync(process.argv[2], 'utf8').trim();
  const out = qoderBase64Decode(input);
  fs.writeFileSync(process.argv[3] || '/dev/stdout', out);
  console.error(`[decode] ${input.length} chars -> ${out.length} bytes`);
}
