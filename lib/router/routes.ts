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
    throw catalogueNotReady([platform]);
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
  // 这边的状态，不是请求本身的问题 —— 答复里说清是哪一种、什么时候恢复
  if (info.untilMs !== null) {
    throw platformUnavailable(platform, info.state, info.untilMs);
  }
  return { platform, model: `${platform}/${canonical}` };
}

/**
 * 这个平台现在接不了请求：额度用尽、或者账号都在冷却。
 *
 * 两种的答法不一样，因为客户端能做的事不一样：
 *
 *   额度用尽 → 402 usage_limit_error：客户端能做的就是充值或者等额度。
 *   冷却     → 503：等一会儿就好，说清到什么时候。
 *
 * 两种都点名平台：客户端要知道是哪个上游接不了，不是一个笼统的「都满了」。
 */
export function platformUnavailable(
  platform: string,
  state: PlatformState,
  untilMs: number | null,
): AuthError {
  if (state === "out_of_credits") return platformOutOfCredits(platform, untilMs);
  if (state === "cooling") return platformCooling(platform, untilMs);
  // 别的状态到不了这里（它们的恢复时间是 null）。真到了就照 503 说：等一会儿
  // 再试，答复里用同一套词说清是什么状态、该做什么 —— 不另造第四套说法。
  const error = new AuthError(
    `upstream ${platform} cannot serve the request`,
    `上游 ${platform} 现在接不了这个请求：${STATE_TEXT[state]}（${state}）—— ${remedyOf(state)}`,
    503,
  );
  return untilMs === null ? error : withRetryAfter(error, untilMs);
}

/**
 * 上游的额度用尽了：402。
 *
 * 402 是「客户端自己能动手的事」：余额或额度用尽时，客户端能做的就是充值、
 * 或者等额度回来。503 说的是「等一会儿就好」，但额度等的是窗口，不是几秒。
 *
 * Retry-After 跟着错误走（deliver.ts 把它写进头里）：什么时候恢复是平台自己
 * 说的时刻，不是猜的。
 */
function platformOutOfCredits(platform: string, untilMs: number | null): AuthError {
  const when = untilMs === null ? "" : `，${cooldownStamp(untilMs)} 恢复`;
  const error = new AuthError(
    `upstream ${platform} is out of credits`,
    `上游 ${platform} 的额度用尽了${when}。额度回来之前接不了这个请求；能做的就是充值或者等额度。`,
    402,
    "usage_limit_error",
  );
  return untilMs === null ? error : withRetryAfter(error, untilMs);
}

/**
 * 上游的账号都在冷却：503。
 *
 * 冷却是分钟级的：等一会儿就好，所以是 503，不是 402（那说的是额度用尽）。
 * 文案点名平台，说清到什么时候再试。
 */
function platformCooling(platform: string, untilMs: number | null): AuthError {
  const when = untilMs === null ? "" : `，${cooldownStamp(untilMs)} 再试`;
  const error = new AuthError(
    `upstream ${platform} is cooling down`,
    `上游 ${platform} 的账号在冷却${when}。到点自动重试。`,
    503,
  );
  return untilMs === null ? error : withRetryAfter(error, untilMs);
}

/**
 * 上游的模型目录还没拿到：503。
 *
 * 不是「没有这个模型」：模型确实发布着，只是上游还没告诉我们它有什么模型。
 * 400 会让客户端去改模型名，503 才是它该做的事 —— 等一会儿。
 */
export function catalogueNotReady(platforms: string[]): AuthError {
  const names = platforms.join("、");
  return new AuthError(
    `upstream catalogue not ready (${names})`,
    `上游 ${names} 的模型目录还没拿到，过一会儿再试。`,
    503,
  );
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
  credential_expired: "凭据过期了",
  credential_unknown: "凭据读不出来",
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
    case "credential_expired":
      return "等它自动刷新，或者重新登录";
    case "credential_unknown":
      return "看日志";
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
 * 都是 400：这是运维没配好（没有账号、账号都关着、没有凭据），客户端处理不了，
 * 也不该去改模型名。
 *
 * 额度用尽与冷却不归这里管：那两个状态的平台照样在目录里（目录恒为平台全量），
 * 所以 findAggregate 有结果，答的是 routeInGroup 那边的 402 与 503 —— 那边点名
 * 平台、说清什么时候恢复。目录空的那种由 emptyCatalogTargets 拦（503：目录
 * 还没拿到）。走到这里的只有「平台接不了，但目录不在那儿」的那几种。
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
  return new AuthError(`model "${modelId}" has no usable upstream`, hint, 400);
}

/**
 * 目标上游的模型目录还没拿到。
 *
 * 目录是空的平台答不了「有没有这个模型」—— 它连自己有什么模型都还不知道。
 * 平台前缀那条路对同样情况答 503（见 routeInGroup），根路由也得一样：两处答
 * 的不一样，客户端就会去改模型名，而模型名是对的。
 *
 * 只算「平台本身没问题、只是目录空着」的那些：接不了但目录在的（没凭据、额度
 * 用尽、冷却）是账号的事，答复该说那件事。
 */
export function emptyCatalogTargets(
  targets: { group: string; enabled: boolean }[],
  availabilities: Map<string, PlatformAvailability>,
): string[] {
  const out: string[] = [];
  for (const target of targets) {
    if (!target.enabled) continue;
    const availability = availabilities.get(target.group);
    // 目标的上游整个没了（平台被删了）：那是「没有这个模型」，不是「目录没拿到」。
    if (!availability) continue;
    // 接不了但目录在的：那是账号的事，不是目录的事。
    if (
      availability.state !== "ready" &&
      availability.state !== "out_of_credits" &&
      availability.state !== "cooling"
    ) {
      continue;
    }
    // 目录拿到了就没什么好等的。
    if (availability.ids.length) continue;
    out.push(target.group);
  }
  return out;
}
