// lib/router/routes.ts — where a request goes.
//
// A client that talks to one upstream says so in the base URL — `/qoder-cn/v1`
// — and uses the model's real name. The plain `/v1` form takes the upstream in
// the model name (`qoder-cn/glm-5.3`). Both spellings end up at the same place:
// the server prefixes the model internally, so the two never have to be kept
// in step by hand.

import { AuthError } from "../credential.ts";
import { GROUP_PREFIX, UPSTREAM_GROUPS, type UpstreamGroup } from "./catalog.ts";

export { GROUP_PREFIX, UPSTREAM_GROUPS };
export type { UpstreamGroup };

export interface Route {
  upstream:
    | "qoder"
    | "minimax"
    | "minimax-api"
    | "workbuddy"
    | "tokenrhythm"
    | "sensenova"
    | "intern-ai";
  /** The model as the server names it: prefixed, e.g. `qoder-cn/glm-5.3`. */
  model: string;
  /** Which Qoder region to talk to. Unset for MiniMax. */
  region?: "cn" | "global";
  /**
   * The name to report back to the client.
   *
   * The aggregate route publishes models under names of its own, so the answer
   * has to carry the name the client asked for rather than the upstream's.
   */
  label?: string;
}

/** What the router is serving, and what it knows about. */
export interface RoutingContext {
  enabled: {
    minimax: boolean;
    minimaxApi: boolean;
    qoderGlobal: boolean;
    qoderCn: boolean;
    workbuddyCn: boolean;
    tokenrhythm: boolean;
    sensenova: boolean;
    internAi: boolean;
  };
  /** The models each upstream can serve. */
  ids: {
    qoderGlobal: Set<string>;
    qoderCn: Set<string>;
    qoderHidden: Set<string>;
    minimax: Set<string>;
    minimaxApi: Set<string>;
    workbuddy: Set<string>;
    tokenrhythm: Set<string>;
    sensenova: Set<string>;
    internAi: Set<string>;
  };
}

/** The group a request path addresses, if any. */
export function groupFromPath(path: string): UpstreamGroup | undefined {
  const first = (path.split("/")[1] ?? "").toLowerCase();
  return (UPSTREAM_GROUPS as string[]).includes(first) ? (first as UpstreamGroup) : undefined;
}

/** The model as the upstream knows it, prefix stripped. */
export function upstreamModel(route: Route): string {
  for (const group of UPSTREAM_GROUPS) {
    const prefix = GROUP_PREFIX[group];
    if (route.model.startsWith(prefix)) return route.model.slice(prefix.length);
  }
  return route.model;
}

/** Decide where a request goes, and what the upstream should call the model. */
export function resolveRoute(model: string, ctx: RoutingContext): Route {
  const raw = String(model ?? "").trim();
  if (raw.startsWith("workbuddy-cn/")) return workbuddyRoute(raw.slice("workbuddy-cn/".length), ctx);
  if (raw.startsWith("qoder-cn/")) return qoderRoute(raw.slice("qoder-cn/".length), "cn", ctx);
  if (raw.startsWith("qoder/")) return qoderRoute(raw.slice("qoder/".length), "global", ctx);
  if (raw.startsWith("sensenova/")) return senseNovaRoute(raw.slice("sensenova/".length), ctx);
  if (raw.startsWith("intern-ai/")) return internAiRoute(raw.slice("intern-ai/".length), ctx);
  if (raw.startsWith("tokenrhythm/")) {
    if (!ctx.enabled.tokenrhythm) throw disabledUpstream("tokenrhythm");
    return { upstream: "tokenrhythm", model: raw };
  }
  if (raw.startsWith("minimax/")) {
    if (!ctx.enabled.minimax) throw disabledUpstream("minimax");
    return { upstream: "minimax", model: raw };
  }
  if (raw.startsWith("minimax-api/")) {
    if (!ctx.enabled.minimaxApi) throw disabledUpstream("minimax-api");
    return { upstream: "minimax-api", model: raw };
  }
  if (ctx.ids.tokenrhythm.has(raw)) {
    if (!ctx.enabled.tokenrhythm) throw disabledUpstream("tokenrhythm");
    return { upstream: "tokenrhythm", model: `tokenrhythm/${raw}` };
  }
  const minimaxModel = matchMinimaxModel(raw, ctx.ids.minimax);
  if (minimaxModel) {
    if (!ctx.enabled.minimax) throw disabledUpstream("minimax");
    return { upstream: "minimax", model: `minimax/${minimaxModel}` };
  }
  if (ctx.ids.qoderGlobal.has(raw) || ctx.ids.qoderCn.has(raw)) {
    // Known to a region. Prefer one that is enabled; if the only region that has
    // it is off, say so rather than calling it unknown.
    if (ctx.enabled.qoderGlobal && ctx.ids.qoderGlobal.has(raw)) {
      return { upstream: "qoder", model: `qoder/${raw}`, region: "global" };
    }
    if (ctx.enabled.qoderCn && ctx.ids.qoderCn.has(raw)) {
      return { upstream: "qoder", model: `qoder-cn/${raw}`, region: "cn" };
    }
    throw disabledUpstream(ctx.ids.qoderGlobal.has(raw) ? "qoder-global" : "qoder-cn");
  }
  if (ctx.ids.qoderHidden.has(raw)) throw unavailableQoderModel(raw, ctx);
  throw new AuthError(
    `unknown model "${raw}"`,
    `这个模型不在目录里。用 qoder/、workbuddy-cn/、minimax/、minimax-api/ 或 tokenrhythm/ 前缀显式指定，例如 qoder/auto、workbuddy-cn/glm-5.3、minimax/MiniMax-M3、tokenrhythm/deepseek-v4.1-flash-1017。`,
    400,
  );
}

/**
 * Resolve a model inside one upstream, named by the request path.
 *
 * The model id is the real one — `glm-5.3`, not `qoder-cn/glm-5.3` — because
 * the path already says which upstream it is for.
 */
export function routeInGroup(group: UpstreamGroup, id: string, ctx: RoutingContext): Route {
  switch (group) {
    case "qoder":
      return qoderRoute(id, "global", ctx);
    case "qoder-cn":
      return qoderRoute(id, "cn", ctx);
    case "workbuddy-cn":
      return workbuddyRoute(id, ctx);
    case "tokenrhythm": {
      if (!ctx.enabled.tokenrhythm) throw disabledUpstream("tokenrhythm");
      if (!ctx.ids.tokenrhythm.has(id)) {
        throw new AuthError(
          `unknown model "${id}"`,
          `TokenRhythm 没有这个模型。可用：${[...ctx.ids.tokenrhythm].join("、")}。`,
          400,
        );
      }
      return { upstream: "tokenrhythm", model: `tokenrhythm/${id}` };
    }
    case "minimax": {
      if (!ctx.enabled.minimax) throw disabledUpstream("minimax");
      const canonical = matchMinimaxModel(id, ctx.ids.minimax);
      if (!canonical) {
        throw new AuthError(
          `unknown model "${id}"`,
          `MiniMax 没有这个模型。可用：${[...ctx.ids.minimax].join("、")}。`,
          400,
        );
      }
      // The client catalog's id goes upstream, not the agent's spelling of it.
      return { upstream: "minimax", model: `minimax/${canonical}` };
    }
    case "minimax-api": {
      if (!ctx.enabled.minimaxApi) throw disabledUpstream("minimax-api");
      const canonical = matchMinimaxModel(id, ctx.ids.minimaxApi);
      if (!canonical) {
        throw new AuthError(
          `unknown model "${id}"`,
          `MiniMax 开放平台没有这个模型。可用：${[...ctx.ids.minimaxApi].join("、")}。`,
          400,
        );
      }
      return { upstream: "minimax-api", model: `minimax-api/${canonical}` };
    }
    case "sensenova":
      return senseNovaRoute(id, ctx);
    case "intern-ai":
      return internAiRoute(id, ctx);
  }
}

/**
 * SenseNova 的一个模型。
 *
 * 目录是跟着 key 走的，所以它一开始是空的（网关还没问过上游）。空的时候不
 * 拦：拦了说的是「没有这个模型」，而真相是「还不知道有哪些模型」。上游自己
 * 会把不认得的模型退回来，那时才是该说的话。
 */
function senseNovaRoute(id: string, ctx: RoutingContext): Route {
  if (!ctx.enabled.sensenova) throw disabledUpstream("sensenova");
  const known = ctx.ids.sensenova;
  if (known.size && !known.has(id)) {
    throw new AuthError(
      `unknown model "${id}"`,
      `SenseNova 没有这个模型。可用：${[...known].join("、")}。`,
      400,
    );
  }
  return { upstream: "sensenova", model: `sensenova/${id}` };
}

/**
 * 书生·端砚（Discovery）的一个模型。
 *
 * 与 SenseNova 一样：目录空着的时候不拦，让上游说话。
 */
function internAiRoute(id: string, ctx: RoutingContext): Route {
  if (!ctx.enabled.internAi) throw disabledUpstream("intern-ai");
  const known = ctx.ids.internAi;
  if (known.size && !known.has(id)) {
    throw new AuthError(
      `unknown model "${id}"`,
      `书生·端砚没有这个模型。可用：${[...known].join("、")}。`,
      400,
    );
  }
  return { upstream: "intern-ai", model: `intern-ai/${id}` };
}

/**
 * Find the MiniMax model an agent asked for, ignoring case.
 *
 * Agents spell the id their own way — the desktop client's own catalog says
 * "Minimax-M3.1-Flash" where ours says "MiniMax-M3.1-Flash". The request
 * still has to reach the upstream as the client would send it, so the agent's
 * spelling only identifies the model; the client's id is what goes out.
 */
function matchMinimaxModel(id: string, known: Set<string>): string | null {
  if (known.has(id)) return id;
  const lower = id.toLowerCase();
  for (const candidate of known) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return null;
}

/** WorkBuddy's China region. */
function workbuddyRoute(id: string, ctx: RoutingContext): Route {
  if (!ctx.enabled.workbuddyCn) throw disabledUpstream("workbuddy-cn");
  if (!ctx.ids.workbuddy.has(id)) {
    throw new AuthError(
      `unknown model "${id}"`,
      `WorkBuddy 中国区没有这个模型。可用：${[...ctx.ids.workbuddy].join("、")}。`,
      400,
    );
  }
  return { upstream: "workbuddy", model: `workbuddy-cn/${id}`, region: "cn" };
}

/** An upstream that this router is not serving, because it was not enabled. */
export function disabledUpstream(
  which:
    | "minimax"
    | "minimax-api"
    | "qoder-global"
    | "qoder-cn"
    | "workbuddy-cn"
    | "tokenrhythm"
    | "sensenova"
    | "intern-ai",
): AuthError {
  const flag =
    which === "minimax"
      ? "MINIMAX_CODE"
      : which === "minimax-api"
        ? "MINIMAX_API"
        : which === "qoder-cn"
        ? "QODER_CN"
        : which === "workbuddy-cn"
          ? "WORKBUDDY_CN"
          : which === "tokenrhythm"
            ? "TOKENRHYTHM"
            : which === "sensenova"
              ? "SENSENOVA"
              : which === "intern-ai"
                ? "INTERN_AI"
                : "QODER_GLOBAL";
  const what =
    which === "minimax"
      ? "MiniMax Code"
      : which === "minimax-api"
        ? "MiniMax 开放平台"
        : which === "qoder-cn"
        ? "Qoder 中国区"
        : which === "workbuddy-cn"
          ? "WorkBuddy 中国区"
          : which === "tokenrhythm"
            ? "TokenRhythm"
            : which === "sensenova"
              ? "SenseNova"
              : which === "intern-ai"
                ? "书生·端砚"
                : "Qoder 全球区";
  return new AuthError(
    `${which} is not enabled`,
    `${what}没有启用。设置 ${flag}=true 后重启 router。`,
    400,
  );
}

/** A model the catalog knows, but no region can serve. */
export function unavailableQoderModel(id: string, ctx: RoutingContext): AuthError {
  const global = [...ctx.ids.qoderGlobal].join("、");
  const cn = [...ctx.ids.qoderCn].join("、");
  const hints = [
    ctx.enabled.qoderGlobal ? `可用（全球区）：${global}` : null,
    ctx.enabled.qoderCn ? `可用（中国区）：${cn}` : null,
  ].filter(Boolean);
  return new AuthError(
    `model "${id}" is not available`,
    `Qoder 的 ${id} 目前没有可用的区域：全球区的新协议不认它，老协议被限流/额度卡住；中国区把它排进了队列。${hints.join("；") || "当前没有启用任何 Qoder 区域。"}`,
    400,
  );
}

function qoderRoute(id: string, region: "cn" | "global", ctx: RoutingContext): Route {
  if (!(region === "cn" ? ctx.enabled.qoderCn : ctx.enabled.qoderGlobal)) {
    throw disabledUpstream(region === "cn" ? "qoder-cn" : "qoder-global");
  }
  const known = region === "cn" ? ctx.ids.qoderCn : ctx.ids.qoderGlobal;
  if (known.has(id)) {
    return { upstream: "qoder", model: `${GROUP_PREFIX[region === "cn" ? "qoder-cn" : "qoder"]}${id}`, region };
  }
  if (ctx.ids.qoderHidden.has(id)) throw unavailableQoderModel(id, ctx);
  // Known to the other region but not to this one: point at it.
  const other = region === "cn" ? "global" : "cn";
  if ((region === "cn" ? ctx.ids.qoderGlobal : ctx.ids.qoderCn).has(id)) {
    if (!(other === "cn" ? ctx.enabled.qoderCn : ctx.enabled.qoderGlobal)) {
      throw disabledUpstream(other === "cn" ? "qoder-cn" : "qoder-global");
    }
    throw new AuthError(
      `model "${id}" is not available in the ${region} region`,
      `这个模型只在 ${other} 区有。用另一个上游的路径指定它：${other === "cn" ? "/qoder-cn/v1" : "/qoder/v1"}。`,
      400,
    );
  }
  throw new AuthError(
    `unknown model "${id}"`,
    `Qoder ${region} 区没有这个模型。可用：${[...known].join("、")}。`,
    400,
  );
}
