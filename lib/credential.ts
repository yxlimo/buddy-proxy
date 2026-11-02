// lib/credential.ts — the credential shape every source produces, and the error the
// proxy answers with. Split out so the read-only desktop-app reader and the proxy's
// own OAuth session can both build on it without importing each other.
//
// Two sources, one shape:
//   lib/minimax/file-store.ts  reads the desktop app's store (never writes)
//   lib/minimax/oauth.ts       owns its own session (logs in, refreshes)
// lib/minimax/auth.ts picks between them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tighten } from "./store-migrate.ts";

/** 这个进程里已经收紧过的 auth.log：每条日志都 chmod 一次没必要。 */
const tightened = new Set<string>();

export const DEFAULT_CLIENT_ID = "mcode-public";
export const DEFAULT_AUDIENCE = "agent-backend";
export const DEFAULT_SCOPES = ["agent.default"];
export const DEFAULT_REGION = "cn";

/**
 * Append a line to `auth.log` in the given data directory, and echo it to stdout.
 *
 * The file lives in the data volume, so it outlives a container rebuild — `docker
 * logs` does not. Credential trouble is exactly the thing you want to be able to
 * read after the fact: a refresh that returns a token the gateway then rejects
 * leaves no trace in the container log once the container is replaced.
 */
export function authLog(dir: string, event: string, detail = ""): void {
  const line = `${new Date().toISOString()} ${event}${detail ? " " + detail : ""}`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 0600：日志里只有指纹，但账号、时间线与平台的原话也不是谁都该读的。
    // mode 只在新建时生效，所以旧版留下的（0644）每个进程收紧一次。
    const file = path.join(dir, "auth.log");
    fs.appendFileSync(file, line + "\n", { mode: 0o600 });
    if (!tightened.has(file)) {
      tightened.add(file);
      tighten(file, 0o600);
    }
  } catch {
    /* logging must never break a request */
  }
  console.log(`[AUTH] ${event}${detail ? " " + detail : ""}`);
}

/**
 * A token is a secret; logs only ever carry a fingerprint of it.
 *
 * The first four characters say which kind of token it is (`mmoat_`, `sk-`…),
 * and a short hash tells two tokens apart without giving any more of either
 * away. Ten characters of a short token were most of it; the length helped
 * guess the rest.
 */
export function tokenFingerprint(token: string): string {
  if (!token) return "(empty)";
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
  return `${token.slice(0, 4)}…#${hash}`;
}

export interface Credential {
  accessToken: string;
  generation: number;
  expiresAtMs: number;
  remainingMs: number;
  /** Status reported by the source: the app's own view, or "authenticated". */
  status: string;
  clientId: string;
  audience: string;
  scopes: string[];
  region: string;
  /** Where the credential came from (a file path). */
  source: string;
  /** Who owns the session: the desktop app ("file"), or this proxy ("oauth"). */
  owner: "file" | "oauth";
  /** True when the token is inside the warning window. */
  warning: boolean;
  /** True when the source had no authoritative record and fell back to a guess. */
  fallback?: boolean;
}

/** Thrown when a credential cannot be used. `status` is the HTTP code. */
export class AuthError extends Error {
  status: number;
  hint: string;
  /** The error type the agent sees, when it is not the usual one for the status. */
  type?: string;

  constructor(message: string, hint: string, status = 503, type?: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.hint = hint;
    this.type = type;
  }
}
