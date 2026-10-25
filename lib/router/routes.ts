// lib/router/routes.ts — where a request goes.
//
// A client that talks to one platform says so in the base URL — `/qoder-cn/v1`
// — and uses the model's real name. The plain `/v1` form takes the platform in
// the model name (`qoder-cn/glm-5.3`). Both spellings end up at the same place:
// the server prefixes the model internally, so the two never have to be kept
// in step by hand.
//
// The prefix is the platform's id, not its kind: the two Qoder regions are two
// platforms, each with its own path. Which account of the platform pays for
// the request is the platform policy's business (lib/router/upstreams.ts).

import { AuthError } from "../credential.ts";
import { matchZcodeModel } from "../zcode/models.ts";

export interface Route {
  /**
   * Which platform serves the request — the path segment.
   *
   * The account is not part of the route: a platform has several accounts and
   * the policy picks one per request. An adapter that needs a credential takes
   * the accounts of this platform and asks the policy which one serves it.
   */
  platform: string;
  /** The model as the server names it: prefixed, e.g. `qoder-cn/glm-5.3`. */
  model: string;
  /**
   * The name to report back to the agent.
   *
   * The aggregate route publishes models under names of its own, so the answer
   * has to carry the name the agent asked for rather than the upstream's.
   */
  label?: string;
}

/** What the router is serving, and what it knows about. */
export interface RoutingContext {
  /**
   * Every platform, by id.
   *
   * `ids` is the models the platform can serve right now: at least one of its
   * accounts is on and has something left. `accounts` is how many rows the
   * platform has, so a request can be told "there is no account yet" apart
   * from "every account is off".
   */
  platforms: Map<string, { kind: string; enabled: boolean; accounts: number; ids: Set<string> }>;
}

/** The model as the upstream knows it, prefix stripped. */
export function upstreamModel(route: Route): string {
  const prefix = platformPrefix(route.platform);
  if (route.model.startsWith(prefix)) return route.model.slice(prefix.length);
  return route.model;
}

/** The prefix the server puts in front of a model's name. */
function platformPrefix(platformId: string): string {
  return `${platformId}/`;
}

/**
 * 路径形式：/{平台}/v1/messages，模型名是真的。
 *
 * The path names the platform; the model in the body is the real one.
 */
export function routeInGroup(platform: string, model: string, ctx: RoutingContext): Route {
  const info = ctx.platforms.get(platform);
  if (!info) {
    throw new AuthError(
      `unknown upstream "${platform}"`,
      `没有这个上游：${platform}。可用：${[...ctx.platforms.keys()].join("、")}。`,
      400,
    );
  }
  if (!info.enabled) throw platformWithoutAccount(platform, info.accounts);
  const raw = String(model ?? "").trim();
  const canonical = canonicalModel(raw, info.kind, info.ids);
  if (!canonical) {
    throw new AuthError(
      `unknown model "${raw}"`,
      `这个上游没有这个模型。可用：${[...info.ids].join("、")}。`,
      400,
    );
  }
  return { platform, model: `${platform}/${canonical}` };
}

/** The name the upstream knows the model by. */
function canonicalModel(raw: string, kind: string, ids: Set<string>): string | null {
  if (ids.has(raw)) return raw;
  if (kind === "zcode") return matchZcodeModel(raw)?.id ?? null;
  // The MiniMax family is matched without regard to case: the agent may write
  // "Minimax-M3.1-Flash" and the upstream knows "MiniMax-M3.1-Flash".
  const lower = raw.toLowerCase();
  for (const candidate of ids) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return null;
}

/**
 * 这个平台接不了请求：没有账号，或者账号都关着。
 *
 * The two are different mistakes with different fixes, so the hint says which
 * one it is.
 */
export function platformWithoutAccount(platformId: string, accounts: number): AuthError {
  return new AuthError(
    accounts === 0 ? `platform ${platformId} has no account` : `platform ${platformId} has no account turned on`,
    accounts === 0
      ? `这个平台还没有账号。在面板的「上游」页给它加一个账号并登录。`
      : `这个平台的账号都关着。在面板的「上游」页打开一个账号。`,
    400,
  );
}
