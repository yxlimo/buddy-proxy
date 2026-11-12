// lib/minimax/hosts.ts — where a MiniMax call goes.
//
// The hosts that go through this module, one table each: the LLM gateway
// (transport.ts), the balance and token plan host (credits.ts), the points host
// and the web host (points.ts), the sign-in gateway (checkin.ts), the account
// host (oauth.ts). Every module that walks to one of them reads the same layers
// in the same order:
//
//   1. the host's own setting — a knob for this one host, so an operator can
//      move the balance somewhere without dragging the points along, and a
//      test can aim one call at a fake upstream and leave the rest alone
//   2. the shared setting, `MINIMAX_API_BASE` — moves the whole data plane at
//      once. The offline self-tests and an internal mirror need exactly that:
//      every call of a scan has to land on one fake upstream instead of the
//      real platform, and a mirror serves the whole surface behind one address
//      rather than five. The account host skips this layer, and only it: it is
//      the login endpoint, so what that setting diverts (spending, reading a
//      balance) is not what it serves (oauth.ts says why in full)
//   3. the default table, per region — the platform keeps two regions on
//      different hosts (`minimaxi.com` / `minimax.cn` against `minimax.io`),
//      so the fallback is a table, not one constant. A default that holds one
//      region's host is a request sent to the wrong platform for everyone in
//      the other region. Both entries are required, so a table that loses one
//      does not compile
//
// Empty means "not set", and only that: an empty setting falls through to the
// next layer instead of being aimed at "". The answer loses its trailing
// slashes, so every caller can join a path on with `${host}${path}`.
//
// The layers hold two different kinds of value, and the difference matters
// where a table entry is a whole base rather than a host: see `sharedPath` on
// HostChoice for which host that is and why the shared layer cannot carry the
// path itself.

import { configString } from "../config.ts";

export interface HostChoice {
  /**
   * The setting that moves this host alone. Left out where the host has no
   * knob of its own — inventing one nobody sets would be a panel entry that
   * lies about what can be configured.
   */
  setting?: string;
  /**
   * The setting that moves the whole surface. Left out where the host does not
   * take it — the login host is the one that does not, for the reason oauth.ts
   * gives.
   */
  shared?: string;
  /**
   * The host per region key, both entries required: `cn` is what an unknown
   * region takes, and `en` has to be stated so a table cannot fall back to the
   * home region's platform by leaving it out.
   */
  defaults: Readonly<Record<"cn" | "en", string>>;
  /**
   * The region as the caller has it — usually `MINIMAX_REGION`, so `en` / `cn` /
   * "", and not necessarily a key of `defaults`. Normalised here, so no caller
   * has to know which spelling reaches the other region (see regionKey).
   */
  region: string;
  /**
   * The path a table entry carries, put back on the shared setting when it wins.
   *
   * The tables are not uniform, and the asymmetry is the reason this field
   * exists: four of the five hosts are reached at their origin, so their
   * entries are hosts and each module appends its own path (`/account/...`,
   * `/backend/...`), while the LLM gateway's instructions live under
   * `/llm/v1`, so its entries are whole bases. `MINIMAX_API_BASE` is a host —
   * one address for a mirror or a fake upstream, with the callers appending
   * their paths to it — so on a table whose entry is a base, that entry's path
   * is lost the moment the shared layer wins.
   *
   * So it is appended on the shared layer and nowhere else: the host's own
   * setting and the table entry are already the whole base, and adding the path
   * twice would 404 just as quietly as dropping it once did.
   */
  sharedPath?: string;
}

/** One setting, or "" when it is not set. Read on every call, like the other hot ones. */
function layer(key: string | undefined): string {
  if (!key) return "";
  return configString(key, "");
}

/** A host with its trailing slashes off. */
function bare(host: string): string {
  return host.replace(/\/+$/, "");
}

/**
 * The region key every host table is written in: `cn` or `en`.
 *
 * `en` is narrow on purpose. Only a literal `en` reaches the international
 * column; `global`, `international`, empty and every unknown spelling take
 * `cn`. There is one region this gateway really runs in, and the second column
 * is there for a deployment that states `MINIMAX_REGION=en` out loud.
 *
 * Reading the other region out of a spelling is what was taken back out: `global`
 * used to count as international here, which made the region a property of
 * whichever word a caller happened to write rather than of the deployment. An
 * international build of the platform is another platform's business — its own
 * hosts, its own entitlements, its own kind in `lib/kinds.ts` — and it does not
 * get decided at run time by a string. So a deployment that means those hosts
 * says `en`, and a spelling nobody meant lands on the home region's hosts, which
 * do answer, instead of on a platform the account has no standing on.
 *
 * One normalisation, here, and every table is keyed `cn` / `en`: the modules
 * that walk to a host only pass the string along and none of them re-decides
 * what it means.
 */
export function regionKey(region: string): "cn" | "en" {
  return region.trim().toLowerCase() === "en" ? "en" : "cn";
}

/**
 * The region's host.
 *
 * No fallback branch: `defaults` has to carry both entries, so a table that
 * forgets `en` does not compile. Both fallbacks the old lookup allowed were
 * worse than that compile error — `?? cn` sent a request to the home region's
 * platform, which answers rather than fails, and `?? ""` aimed a request at an
 * empty host.
 */
function defaultHost(defaults: Readonly<Record<"cn" | "en", string>>, key: "cn" | "en"): string {
  return defaults[key];
}

/**
 * The base url of one MiniMax host: own setting, then the shared setting, then
 * the region's default.
 *
 * The names of the settings are the caller's: this function only knows the
 * order, so a host that stops having a knob of its own (or gains one) is a
 * change in its module, not here.
 */
export function resolveHost(choice: HostChoice): string {
  const own = layer(choice.setting);
  if (own) return bare(own);
  const shared = layer(choice.shared);
  if (shared) return `${bare(shared)}${choice.sharedPath ?? ""}`;
  return bare(defaultHost(choice.defaults, regionKey(choice.region)));
}
