// lib/minimax-auth.ts — which credential source the proxy uses. Both produce the same
// Credential (lib/credential.ts), so nothing above this layer cares which one is active.
//
//   MINIMAX_AUTH_MODE=oauth   (default) the proxy's own session: it logs in once and
//                             refreshes itself. This is the Docker route, and the only
//                             one that works in a container.
//   MINIMAX_AUTH_MODE=file    read-only view of the MiniMax Code desktop app's store.
//                             Works only when that store is readable from inside the
//                             process, and can never refresh.
//
// The distinction that matters: who owns the session. The file source must not refresh
// because the desktop app tracks a `generation` and would see a session change; the
// oauth source is the sole writer of its own file, so refreshing is unambiguous.

import { readEnvString } from "./env.ts";
import { AuthError } from "./credential.ts";
import type { Credential } from "./credential.ts";
import * as fileStore from "./minimax-file-store.ts";
import * as oauth from "./minimax-oauth.ts";

export type AuthMode = "oauth" | "file";

const RAW_MODE = readEnvString("MINIMAX_AUTH_MODE", "oauth").trim().toLowerCase();
export const AUTH_MODE: AuthMode = RAW_MODE === "file" ? "file" : "oauth";

export const AUTH_WARN_MS = AUTH_MODE === "file" ? fileStore.FILE_WARN_MS : oauth.OAUTH_WARN_MS;

/**
 * `force` means "the token we just sent was rejected, get a usable one now". In oauth
 * mode that refreshes unconditionally; in file mode it only bypasses the cache, since
 * this layer cannot refresh — it waits for the desktop app to have done it.
 */
export async function readCredential(force = false): Promise<Credential> {
  if (AUTH_MODE === "file") return fileStore.readFileCredential(force);
  return oauth.ensureCredential(force);
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function credentialStatus(): Record<string, unknown> {
  const status = AUTH_MODE === "file" ? fileStore.fileCredentialStatus() : oauth.oauthStatus();
  return { mode: AUTH_MODE, ...status };
}

export { AuthError };
export type { Credential };
