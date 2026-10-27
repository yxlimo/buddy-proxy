// lib/health-cache.ts — the health snapshot's row in the cache table.
//
// The snapshot is what /health and the panel read: every upstream's own answer
// about its accounts. It is a cache row like any other, and the id lives here
// so that the modules which read it (the routing layer asks it for a plan
// window) do not have to pull the whole admin module in.

/** The snapshot's row in the cache table. */
export const HEALTH_CACHE_ID = "health:upstreams:v2";
