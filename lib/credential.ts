// lib/credential.ts — the credential shape every source produces, and the error the
// proxy answers with. Split out so the read-only desktop-app reader and the proxy's
// own OAuth session can both build on it without importing each other.
//
// Two sources, one shape:
//   lib/minimax-file-store.ts  reads the desktop app's store (never writes)
//   lib/minimax-oauth.ts       owns its own session (logs in, refreshes)
// lib/minimax-auth.ts picks between them.

export const DEFAULT_CLIENT_ID = "mcode-public";
export const DEFAULT_AUDIENCE = "agent-backend";
export const DEFAULT_SCOPES = ["agent.default"];
export const DEFAULT_REGION = "cn";

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
  /** The error type the client sees, when it is not the usual one for the status. */
  type?: string;

  constructor(message: string, hint: string, status = 503, type?: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.hint = hint;
    this.type = type;
  }
}
