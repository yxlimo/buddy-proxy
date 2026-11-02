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
// the request is the platform policy's business (lib/router/upstreams/).

import { AuthError } from "../credential.ts";
import { matchZcodeModel } from "../zcode/models.ts";
import type { PlatformAvailability, PlatformState } from "./availability.ts";
import { cooldownStamp } from "./account-cooldown.ts";
import { coolingError } from "./upstreams/policy.ts";
import { withRetryAfter } from "./deliver.ts";

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
   * `ids` is the platform's whole catalogue — every model it serves, whatever
   * its accounts are doing right now. `accounts` is how many rows the platform
   * has, so a request can be told "there is no account yet" apart from "every
   * account is off".
   *
   * `untilMs` says when the platform can serve again when none of its accounts
   * can right now (out of credits, or every one of them cooling down); `null`
   * means nothing is standing in the way.
   *
   * `state` is why the platform is in the state it is in (see
   * lib/router/availability.ts): 开着但没有凭据、账号都关着、还没有账号 —— 三件
   * 要改的地方不一样，提示里得说清是哪一件。
   */
  platforms: Map<
    string,
    {
      kind: string;
      enabled: boolean;
      accounts: number;
      ids: Set<string>;
      untilMs: number | null;
      state: PlatformState;
    }
  >;
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
  if (!info.enabled) throw platformWithoutAccount(platform, info.state);
  const raw = String(model ?? "").trim();
  // 目录还没拿到（账号刚加、目录还没同步）：这不是「没有这个模型」，是「这个
  // 上游现在答不了」。400 会让客户端去改配置，503 才是它该做的事 —— 等一会儿
  if (!info.ids.size) {
    throw new AuthError(
      `platform ${platform} has no model catalogue`,
      `这个上游的模型目录还没拿到（账号刚加或者目录还没同步）。稍后再试。`,
      503,
    );
  }
  const canonical = canonicalModel(raw, info.kind, info.ids);
  if (!canonical) {
    throw new AuthError(
      `unknown model "${raw}"`,
      `这个上游没有这个模型。可用：${[...info.ids].join("、")}。`,
      400,
    );
  }
  // 模型在目录里，但平台下没有一个账号能接：额度用尽或者都在冷却。这是网关
  // 这边的状态，不是请求本身的问题 —— 503 加上什么时候恢复，客户端照着重试
  if (info.untilMs !== null) {
    throw coolingError(platform, info.untilMs, true, "额度用尽或者冷却中");
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
 * 这个平台接不了请求：没有账号、账号都关着，或者没有可用凭据。
 *
 * 三件是要改的地方不一样的事：加一个账号、打开一个账号、在面板上填 key 或者
 * 登录。提示里得说清是哪一件，不然人只能一个个试。
 *
 * 都是 400：这是运维没配好，不是「等一会儿再来」。
 */
export function platformWithoutAccount(platformId: string, state: PlatformState): AuthError {
  if (state === "no_credential") {
    return new AuthError(
      `platform ${platformId} has no usable credential`,
      `这个平台的账号都还没有可用凭据。在面板的「上游」页填 API Key 或者登录。`,
      400,
    );
  }
  if (state === "no_account") {
    return new AuthError(
      `platform ${platformId} has no account`,
      `这个平台还没有账号。在面板的「上游」页给它加一个账号并登录。`,
      400,
    );
  }
  // 账号都关着。另外两个状态到不了这里：它们说明账号与凭据都在。
  return new AuthError(
    `platform ${platformId} has no account turned on`,
    `这个平台的账号都关着。在面板的「上游」页打开一个账号。`,
    400,
  );
}

/* ------------------------------------------------------------------ *
 * 发布出来的模型，现在接不了
 * ------------------------------------------------------------------ */

/** 一个目标上游现在接不了：它是什么状态、什么时候能接。 */
export interface UnreachableUpstream {
  /** 平台 id（请求路径里的那一段）。 */
  platform: string;
  /** 现在的状态。 */
  state: PlatformState;
  /** 最早能试的时刻。不知道就是 null。 */
  untilMs: number | null;
}

/** 每个状态是什么问题：一句话。 */
const STATE_TEXT: Record<PlatformState, string> = {
  no_account: "没有账号",
  accounts_off: "账号都关着",
  no_credential: "没有可用凭据",
  out_of_credits: "额度用尽",
  cooling: "账号都在冷却里",
  ready: "就绪",
};

/** 每个状态该怎么办：一句话，说给运维听。 */
function remedyOf(state: PlatformState): string {
  switch (state) {
    case "no_account":
      return "在面板的「上游」页加一个账号并登录";
    case "accounts_off":
      return "在面板的「上游」页打开一个账号";
    case "no_credential":
      return "在面板的「上游」页填 API Key 或者登录";
    case "out_of_credits":
      return "等额度恢复";
    case "cooling":
      return "等冷却结束";
    case "ready":
      return "";
  }
}

/**
 * 发布出来的模型，它的目标上游现在都接不了吗。
 *
 * 空数组表示「不是接不了」：要么没有启用的目标，要么有一个目标接得了（那就
 * 是上游的目录里没有这个模型，404 unknown model 才对）。判定用的是可用性
 * 里的 state —— 不另写一套，免得两处说的不是一件事。
 */
export function unreachableUpstreams(
  targets: { group: string; enabled: boolean }[],
  availabilities: Map<string, PlatformAvailability>,
): UnreachableUpstream[] {
  const out: UnreachableUpstream[] = [];
  for (const target of targets) {
    if (!target.enabled) continue;
    const availability = availabilities.get(target.group);
    // 目标的上游整个没了（平台被删了）：那是「没有这个模型」，不是「接不了」。
    if (!availability) continue;
    // 有一个接得了：这个模型能不能服务要看目录，不是看状态。
    if (availability.state === "ready") return [];
    out.push({
      platform: target.group,
      state: availability.state,
      untilMs: availability.untilMs,
    });
  }
  return out;
}

/**
 * 发布出来的模型现在接不了：点名是哪个上游、什么状态、该做什么。
 *
 * 两种答法：缺凭据、没账号、账号都关着是 400 —— 那是运维没配好，客户端
 * 处理不了，也不该去改模型名；额度用尽与冷却是 503 —— 等一会儿就好，答里
 * 带上什么时候恢复（Retry-After 跟着走）。
 */
export function publishedModelUnavailable(
  modelId: string,
  upstreams: UnreachableUpstream[],
): AuthError {
  const lines = upstreams.map((u) => {
    const when = u.untilMs === null ? "" : `，最早 ${cooldownStamp(u.untilMs)} 恢复`;
    return `  ${u.platform}：${STATE_TEXT[u.state]}（${u.state}）${when} —— ${remedyOf(u.state)}`;
  });
  const hint = `这个模型（${modelId}）发布着，但它的上游现在都接不了：\n${lines.join("\n")}`;
  const recoverable = upstreams.filter(
    (u) => u.state === "out_of_credits" || u.state === "cooling",
  );
  if (!recoverable.length) {
    return new AuthError(`model "${modelId}" has no usable upstream`, hint, 400);
  }
  const untils = recoverable
    .map((u) => u.untilMs)
    .filter((at): at is number => typeof at === "number" && at > Date.now());
  const error = new AuthError(
    `model "${modelId}" has no reachable upstream right now`,
    hint,
    503,
    "api_error",
  );
  return untils.length ? withRetryAfter(error, Math.min(...untils)) : error;
}
