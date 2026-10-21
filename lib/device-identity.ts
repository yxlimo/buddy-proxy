// lib/device-identity.ts — the device fingerprint of an account.
//
// Both upstreams look at the machine code and the session id that come with a
// request. The official client keeps one machine id for the whole installation
// — so two accounts on it look like two accounts on one device, and that is
// what a risk check looks for.
//
// Deriving the pair from the account instead keeps an account stable (the same
// account always looks like the same machine, so nothing drifts) and keeps the
// accounts apart (no two accounts ever look like the same machine).
//
// The derivation is salted with a secret of the installation, so the machine
// token cannot be worked out from the account id alone, and two installations
// of the same account do not correlate either.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DeviceIdentity {
  /** The machine id: the official client sends a UUID here. */
  machineId: string;
  /** The machine token (Qoder): the CLI sends a base64url string. */
  machineToken: string;
  /** The machine type (Qoder): the CLI sends a hex string of its own. */
  machineType: string;
  /** The machine code (Qoder): the desktop app sends one next to the token. */
  machineCode: string;
  /** The session id: the header that every request carries. */
  sessionId: string;
}

function mac(salt: string, label: string): Buffer {
  return crypto.createHmac("sha256", salt).update(label).digest();
}

/** A UUID with the version bits set, so it looks like the ones the CLI sends. */
function asUuid(bytes: Buffer): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The fingerprint of an account.
 *
 * Everything is a function of the account id, so the same account always gets
 * the same fingerprint and two accounts never get the same one.
 */
export function deriveDeviceIdentity(accountId: string, salt: string): DeviceIdentity {
  return {
    machineId: asUuid(mac(salt, `${accountId}:id`)),
    machineToken: mac(salt, `${accountId}:token`).toString("base64url").slice(0, 50),
    machineType: mac(salt, `${accountId}:type`).toString("hex").slice(0, 18),
    machineCode: mac(salt, `${accountId}:code`).toString("hex").slice(0, 32),
    sessionId: asUuid(mac(salt, `${accountId}:session`)),
  };
}

const saltCache = new Map<string, string>();

/**
 * The secret of this installation that the derivation is salted with.
 *
 * It lives next to the sessions, is created once, and is never written to the
 * repository — losing it only means a new fingerprint, not a lost login.
 */
export function deviceSalt(dataDir: string): string {
  const cached = saltCache.get(dataDir);
  if (cached) return cached;
  const file = path.join(dataDir, "identity.salt");
  let salt = "";
  try {
    salt = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* not there yet */
  }
  if (salt.length < 32) {
    salt = crypto.randomBytes(32).toString("base64url");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, salt, { mode: 0o600 });
    } catch {
      /* a read-only data directory still works, the salt just stays in memory */
    }
  }
  saltCache.set(dataDir, salt);
  return salt;
}
