// lib/credential.ts — the credential shape every source produces, and the error the
// proxy answers with. Split out so the read-only desktop-app reader and the proxy's
// own OAuth session can both build on it without importing each other.
//
// Two sources, one shape:
//   lib/minimax/file-store.ts  reads the desktop app's store (never writes)
//   lib/minimax/oauth.ts       owns its own session (logs in, refreshes)
// lib/minimax/auth.ts picks between them.

import fs from "node:fs";
import path from "node:path";

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
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "auth.log"), line + "\n");
  } catch {
    /* logging must never break a request */
  }
  console.log(`[AUTH] ${event}${detail ? " " + detail : ""}`);
}

/** A token is a secret; logs only ever carry its first few characters. */
export function tokenFingerprint(token: string): string {
  return token ? `${token.slice(0, 10)}…(${token.length})` : "(empty)";
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
