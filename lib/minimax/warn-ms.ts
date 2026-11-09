// lib/minimax/warn-ms.ts — how long before the token expires counts as
// "about to expire".
//
// It sits in its own module because the credential sources and the selector
// between them are in one import cycle: auth.ts reads oauth.ts and file-store.ts,
// oauth.ts reaches back through providers/platforms/kinds into transport.ts,
// which reads auth.ts. A constant read across that cycle at module load time
// can hit a binding that is not initialized yet, and the process dies before
// it serves anything.
//
// The config itself has no cycle: lib/config.ts only reaches the store.

import { configNumber } from "../config.ts";

export const WARN_MS = configNumber("MINIMAX_AUTH_WARN_MS", 10 * 60 * 1000);
