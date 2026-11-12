// lib/minimax/hosts.ts — where a MiniMax call goes.
//
// The MiniMax surface answers on several hosts: the LLM gateway, the balance
// host, the points host, the sign-in gateway, the web host. Every module that
// walks to one of them reads the same three layers, in the same order:
//
//   1. the host's own setting — a knob for this one host, so an operator can
//      move the balance somewhere without dragging the points along, and a
//      test can aim one call at a fake upstream and leave the rest alone
//   2. the shared setting, `MINIMAX_API_BASE` — moves the whole MiniMax
//      surface at once. The offline self-tests and an internal mirror need
//      exactly that: every call of a scan has to land on one fake upstream
//      instead of the real platform, and a mirror serves the whole surface
//      behind one address rather than five
//   3. the default table, per region — the platform keeps two regions on
//      different hosts (`minimaxi.com` / `minimax.cn` against `minimax.io`),
//      so the fallback is a table, not one constant. A default that holds one
//      region's host is a request sent to the wrong platform for everyone in
//      the other region
//
// Empty means "not set", and only that: an empty setting falls through to the
// next layer instead of being aimed at "". The answer loses its trailing
// slashes, so every caller can join a path on with `${host}${path}`.

import { configString } from "../config.ts";

export interface HostChoice {
  /**
   * The setting that moves this host alone. Left out where the host has no
   * knob of its own — inventing one nobody sets would be a panel entry that
   * lies about what can be configured.
   */
  setting?: string;
  /** The setting that moves the whole surface. Left out where it is not shared. */
  shared?: string;
  /** The host per region key, with `cn` as the entry an unknown region takes. */
  defaults: Readonly<Record<string, string>>;
  /**
   * The region as the caller has it — the setting or the account record says
   * `en` / `global` / "", not a key of `defaults`. Normalised here, so no
   * caller has to know the tables' vocabulary (see regionKey).
   */
  region: string;
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
 * The platform has two regions, but the string naming one of them arrives
 * spelled several ways: `MINIMAX_REGION` says `cn` / `en`, an account record
 * says `global`, and conversation says "international". Two vocabularies for
 * the same two regions is how a scan reaches the wrong platform — with the
 * tables keyed separately, `en` meant international in one module while
 * `global` meant international in another, and each of them normalised the
 * string on its own before looking the host up.
 *
 * So there is one normalisation, here, and every table is keyed `cn` / `en`:
 * two of the three already were, and `en` and `global` name the same region,
 * so `global` becomes `en` instead of a third key growing back.
 *
 * Anything else — empty, unknown, `EU` — takes `cn`, the home region. The
 * deployments this gateway runs in reach the home region's hosts, and an
 * account that really sits in the other region says `en` / `global`; the
 * fallback is not something anyone relies on, it is what keeps an unknown
 * spelling from looking up nothing and aiming a request at "".
 */
export function regionKey(region: string): "cn" | "en" {
  const key = region.trim().toLowerCase();
  return key === "en" || key === "global" || key === "international" ? "en" : "cn";
}

/** The region's host, or the home region's — no table here is missing `cn`. */
function defaultHost(defaults: Readonly<Record<string, string>>, key: "cn" | "en"): string {
  const table: Record<string, string | undefined> = defaults;
  return table[key] ?? table.cn ?? "";
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
  if (shared) return bare(shared);
  return bare(defaultHost(choice.defaults, regionKey(choice.region)));
}
