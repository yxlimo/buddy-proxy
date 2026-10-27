// lib/minimax/points.ts — the points on a MiniMax Code account, and whether the
// platform is allowed to spend them.
//
// The token plan and the points are two different things. The plan is the
// subscription: a five-hour window and a weekly one, in percent. The points are
// what is left in the credit ledger — bought, or given by the sign-in. When a
// plan window runs out the platform can go on answering by taking points, but
// only if the account has the client's switch for that turned on
// (`usage_credit_fallback`, "Token Plan 达限后使用积分"). With the switch off the
// same request comes back as business code 2067 instead.
//
// So "can this account still answer" needs both numbers, and they live on two
// different hosts with two different kinds of authentication:
//
//   the points   GET  agent.minimax.cn/minimax-cloud/api/v1/credit/details
//                signed (yy / x-timestamp / x-signature) — the same scheme the
//                sign-in calls use, so buildRequest is reused rather than copied
//   the switch   GET  www.minimaxi.com/backend/account/token_plan_credit
//                no signature, but it wants the account group in X-Group-Id
//
// The account group comes out of get_user_extra_info: the entry the desktop
// client has marked `selected`.
//
// Neither answer is a hard requirement. A null means "not known" — the caller
// must treat that as the old behaviour (look at the plan windows only), never as
// "no points".
//
// Two fields of get_user_extra_info are deliberately NOT read:
// `opcredit_balance` and `total_remains_credit`. They look like points, but they
// are the open-platform credits, a different pot from the one MiniMax Code
// spends — a code account reads zero there while its ledger holds real points.
// Adding them back as a fallback would report a paying account as broke, so
// leave them alone even when the credit ledger answers nothing.

import { configString } from "../config.ts";
import { buildRequest } from "./checkin.ts";
import type { MiniMaxRegion } from "./credits.ts";

/** The matrix host (the points). The sign-in gateway is a third host. */
const AGENT_HOSTS: Record<string, string> = {
  cn: "https://agent.minimax.cn",
  en: "https://agent.minimax.io",
};

/** The web host (the switch). */
const WEB_HOSTS: Record<string, string> = {
  cn: "https://www.minimaxi.com",
  en: "https://www.minimax.io",
};

const EXTRA_PATH = "/matrix/api/v1/user/get_user_extra_info";
const CREDIT_PATH = "/minimax-cloud/api/v1/credit/details";
const FALLBACK_PATH = "/backend/account/token_plan_credit";

// The ledger pages at 50 rows a page. Only one page is read: the caller needs a
// yes/no on "any points left", not the breakdown, and 50 lots covers every
// account seen so far (five rows on the real ones). Reading the rest is a detail
// view's job, not the availability check's
const CREDIT_PAGE_SIZE = 50;

const regionKey = (region: string): string => (region === "en" || region === "global" ? "en" : "cn");

/**
 * The base url for one of the two hosts.
 *
 * `MINIMAX_API_BASE` is read as well: it is the one setting the offline tests
 * already use to point the whole MiniMax surface at a fake upstream, and without
 * it these two calls would reach the real hosts during a test run.
 */
function base(setting: string, hosts: Record<string, string>, region: string): string {
  const own = configString(setting, "");
  if (own) return own.replace(/\/+$/, "");
  const shared = configString("MINIMAX_API_BASE", "");
  if (shared) return shared.replace(/\/+$/, "");
  return hosts[regionKey(region)];
}

/** A decimal string from the platform: it may carry thousands separators. */
function amountOf(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).replace(/,/gu, "").trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** One GET or POST, and the parsed answer — or null when anything went wrong. */
async function ask(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
): Promise<any | null> {
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[MINIMAX] ${new URL(url).pathname} 答 HTTP ${res.status}`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    console.warn(`[MINIMAX] ${new URL(url).pathname} 没答上来：${(e as Error)?.message}`);
    return null;
  }
}

/**
 * A signed request, aimed at the matrix host.
 *
 * buildRequest builds the url against the sign-in gateway; only the origin is
 * swapped here. The signature covers path + query (+ body), so the origin is not
 * part of it.
 */
function signedRequest(
  path: string,
  method: "GET" | "POST",
  token: string,
  region: string,
  payload?: string,
  query?: Record<string, string>,
): { url: string; body?: string; headers: Record<string, string> } {
  const built = buildRequest(path, method, token, "", region, Date.now(), payload, query);
  const url = new URL(built.url);
  return {
    url: `${base("MINIMAX_AGENT_BASE", AGENT_HOSTS, region)}${url.pathname}${url.search}`,
    body: built.body,
    headers: built.headers,
  };
}

interface Workspace {
  id: string;
  /** The open-platform account group. The switch wants it in X-Group-Id. */
  groupId: string;
}

// The two answers are asked for one after the other and need the same lookup;
// one entry is enough and saves a second round trip.
let workspaceCache: { token: string; at: number; value: Workspace } | null = null;
const WORKSPACE_TTL_MS = 60_000;

/** The workspace the desktop client has selected, out of get_user_extra_info. */
async function selectedWorkspace(token: string, region: string): Promise<Workspace | null> {
  const cached = workspaceCache;
  if (cached && cached.token === token && Date.now() - cached.at < WORKSPACE_TTL_MS) return cached.value;
  const req = signedRequest(EXTRA_PATH, "POST", token, region);
  const body = await ask(req.url, "POST", req.headers, req.body);
  const rows: any[] = Array.isArray(body?.data?.workspaces)
    ? body.data.workspaces
    : Array.isArray(body?.workspaces)
      ? body.workspaces
      : [];
  const chosen = rows.find((row) => row?.selected) ?? rows[0];
  // The id field is `workspace_id` and it is a number — 0 for the personal
  // workspace, which is the common case, so an empty check would throw it away
  const id = chosen?.workspace_id === null || chosen?.workspace_id === undefined
    ? ""
    : String(chosen.workspace_id);
  if (id === "") {
    console.warn("[MINIMAX] 拿不到 workspace_id（get_user_extra_info 里没有 workspaces）");
    return null;
  }
  const value: Workspace = { id, groupId: String(chosen.op_group_id ?? "") };
  workspaceCache = { token, at: Date.now(), value };
  return value;
}

/**
 * The points left on the account, or null when the platform did not say.
 *
 * The points are the unexpired remainder of the credit ledger, so the first page
 * of the ledger is summed rather than read from a summary field. One page only:
 * the caller asks "is there anything left", and a full page already answers it —
 * paging is for the detail view, not for this check. Expired lots are skipped
 * even though the query already excludes them, because the filter is the part
 * that must not regress if the query ever stops working. A ledger that answers
 * with an empty list really is zero points; a request that fails is "not known"
 * — never zero, because zero would mark a paying account as broke.
 */
export async function fetchMiniMaxPoints(
  accessToken: string,
  region: MiniMaxRegion = "cn",
): Promise<number | null> {
  try {
    const now = Date.now();
    const req = signedRequest(CREDIT_PATH, "GET", accessToken, region, undefined, {
      page_number: "1",
      page_size: String(CREDIT_PAGE_SIZE),
      include_expired: "false",
    });
    const body = await ask(req.url, "GET", req.headers);
    if (!body) return null;
    const rows: any[] | null = Array.isArray(body.details) ? body.details : null;
    if (!rows) {
      console.warn("[MINIMAX] 积分明细答复里没有 details 数组，当作不知道");
      return null;
    }
    let total = 0;
    for (const row of rows) {
      const expireAt = Number(row?.expire_at_ms ?? 0);
      if (expireAt > 0 && expireAt <= now) continue;
      const remaining = amountOf(row?.remaining_amount);
      if (remaining !== null) total += remaining;
    }
    return total;
  } catch (e) {
    console.warn(`[MINIMAX] 读积分失败：${(e as Error)?.message}`);
    return null;
  }
}

/**
 * Is the platform allowed to spend points once a plan window is spent?
 *
 * null is "not known" — not "off". The client skips the X-Group-Id header when it
 * cannot work the group out, so the same is done here rather than failing.
 */
export async function fetchMiniMaxCreditFallback(
  accessToken: string,
  region: MiniMaxRegion = "cn",
): Promise<boolean | null> {
  try {
    const workspace = await selectedWorkspace(accessToken, region);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "MiniMaxCode",
      Authorization: `Bearer ${accessToken}`,
    };
    if (workspace?.groupId) headers["X-Group-Id"] = workspace.groupId;
    const body = await ask(
      `${base("MINIMAX_WEB_BASE", WEB_HOSTS, region)}${FALLBACK_PATH}`,
      "GET",
      headers,
    );
    if (!body) return null;
    const code = body?.base_resp?.status_code;
    if (code !== undefined && Number(code) !== 0) {
      console.warn(`[MINIMAX] 积分自动消耗开关答了业务码 ${code}`);
      return null;
    }
    const enabled = body.token_plan_credit_fallback_enabled;
    if (typeof enabled !== "boolean") {
      console.warn("[MINIMAX] 积分自动消耗开关答复里没有布尔值，当作不知道");
      return null;
    }
    return enabled;
  } catch (e) {
    console.warn(`[MINIMAX] 读积分自动消耗开关失败：${(e as Error)?.message}`);
    return null;
  }
}
