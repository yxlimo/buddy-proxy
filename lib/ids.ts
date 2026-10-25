// lib/ids.ts — the identifiers the upstream clients hand out.
//
// The WorkBuddy upstream is picky about the shape of the ids it takes: the
// conversation request id has to be a lowercase UUIDv7 without dashes, or the
// simulated client itself refuses to send the request. The check in it is
//
//   /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/
//
// so the version nibble sits at position 12 and the variant at position 16.

import { randomBytes } from "node:crypto";

/** A lowercase UUIDv7 as 32 hexadecimal characters, without dashes. */
export function uuidv7Hex(now = Date.now()): string {
  // 48 bits of the timestamp in milliseconds.
  const time = now.toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  // The version nibble (7) at position 12 and the variant nibble (10xx) at
  // position 16 — one hexadecimal character each, which is what the client's
  // own check looks at.
  // The version is 7 and nothing else: the nibble is four bits, and the
  // version is the value 7 in them.
  const version = ((randomBytes(1)[0] & 0x07) | 0x07).toString(16);
  const variant = ((randomBytes(1)[0] & 0x03) | 0x08).toString(16);
  return `${time}${version}${random.slice(0, 3)}${variant}${random.slice(3, 18)}`;
}

/** The same id with dashes, for the places that want a UUID. */
export function uuidv7(now = Date.now()): string {
  const hex = uuidv7Hex(now);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
