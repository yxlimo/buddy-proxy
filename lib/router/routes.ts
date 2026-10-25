// lib/router/routes.ts — where a request goes.
//
// A client that talks to one upstream says so in the base URL — `/qoder-cn/v1`
// — and uses the model's real name. The plain `/v1` form takes the upstream in
// the model name (`qoder-cn/glm-5.3`). Both spellings end up at the same place:
// the server prefixes the model internally, so the two never have to be kept
// in step by hand.
//
// The prefix is the upstream's id, not its kind: two services of the same platform
// are two upstreams, each with its own path.

import { AuthError } from "../credential.ts";
import { matchZcodeModel } from "../zcode/models.ts";

export interface Route {
  /** Which provider serves the request — the row in the provider table. */
  provider: string;
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
   * Every provider, by id.
   *
   * `ids` is the models that provider can serve; `hidden` are the ones it knows
   * but is not serving right now (the upstream is off, or the account has no
   * credits) — a request for one of those gets "not enabled" rather than
   * "no such model".
   */
  providers: Map<string, { kind: string; enabled: boolean; ids: Set<string>; hidden: Set<string> }>;
}

/** The provider a request path addresses, if any. */
export function providerFromPath(path: string): string | undefined {
  const first = (path.split("/")[1] ?? "").toLowerCase();
  if (!first || first === "v1" || first === "admin" || first === "health") return undefined;
  return first;
}

/** The model as the upstream knows it, prefix stripped. */
export function upstreamModel(route: Route): string {
  const prefix = providerPrefix(route.provider);
  if (route.model.startsWith(prefix)) return route.model.slice(prefix.length);
  return route.model;
}

/** The prefix the server puts in front of a model's name. */
export function providerPrefix(providerId: string): string {
  return `${providerId}/`;
}

/** 找出这个模型归哪个 provider —— 第一个开着而且有这个模型的。 */
function providerForModel(raw: string, ctx: RoutingContext): string | undefined {
  for (const [id, info] of ctx.providers) {
    if (info.enabled && info.ids.has(raw)) return id;
  }
  return undefined;
}

/** Decide where a request goes, and what the upstream should call the model. */
export function resolveRoute(model: string, ctx: RoutingContext): Route {
  const raw = String(model ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const prefix = raw.slice(0, slash);
    const rest = raw.slice(slash + 1);
    const info = ctx.providers.get(prefix);
    if (!info) {
      throw new AuthError(
        `unknown provider "${prefix}"`,
        `没有这个 Provider：${prefix}。可用：${[...ctx.providers.keys()].join("、")}。`,
        400,
      );
    }
    if (!info.enabled) throw disabledProvider(prefix);
    return { provider: prefix, model: raw };
  }
  // A bare model name: whichever upstream can serve it.
  const provider = providerForModel(raw, ctx);
  if (provider) return { provider, model: `${provider}/${raw}` };
  // Known but not being served: say so.
  for (const [id, info] of ctx.providers) {
    if (info.hidden.has(raw)) throw disabledProvider(id);
  }
  throw new AuthError(
    `unknown model "${raw}"`,
    `没有哪个 Provider 能服务这个模型。已知的：${knownModels(ctx).join("、")}。`,
    400,
  );
}

/**
 * 路径形式：/{上游}/v1/messages，模型名是真的。
 *
 * The path names the upstream; the model in the body is the real one.
 */
export function routeInGroup(providerId: string, model: string, ctx: RoutingContext): Route {
  const info = ctx.providers.get(providerId);
  if (!info) {
    throw new AuthError(
      `unknown provider "${providerId}"`,
      `没有这个 Provider：${providerId}。可用：${[...ctx.providers.keys()].join("、")}。`,
      400,
    );
  }
  if (!info.enabled) throw disabledProvider(providerId);
  const raw = String(model ?? "").trim();
  const canonical = canonicalModel(raw, info.kind, info.ids);
  if (!canonical) {
    throw new AuthError(
      `unknown model "${raw}"`,
      `这个 Provider 没有这个模型。可用：${[...info.ids].join("、")}。`,
      400,
    );
  }
  return { provider: providerId, model: `${providerId}/${canonical}` };
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

/** Every model any provider can serve. */
export function knownModels(ctx: RoutingContext): string[] {
  const out = new Set<string>();
  for (const info of ctx.providers.values()) {
    for (const id of info.ids) out.add(id);
  }
  return [...out];
}

/** 那个 Provider 没开着。 */
export function disabledProvider(providerId: string): AuthError {
  return new AuthError(
    `provider ${providerId} is not enabled`,
    `这个 Provider 没开着。在面板的「Provider」页打开它，或者用另一个。`,
    400,
  );
}
