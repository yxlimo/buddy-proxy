// lib/minimax/checkin.ts — the daily sign-in of the MiniMax Code account.
//
// The protocol comes from the official client (MiniMax-AI/minimax-code):
//   packages/tui/src/checkin/http-gateway.ts        the two endpoints
//   packages/tui/src/runtime/public-gateway.ts       how the request is built
//
//   GET  {public gateway}/minimax-cloud/api/v1/signin/status
//   POST {public gateway}/minimax-cloud/api/v1/signin/claim   body {}
//
// The answer is a panel of seven days. A day that is claimable gives points;
// the first day of a fresh streak gives a bonus on top. The claim is
// idempotent: claiming twice reports "already claimed" rather than failing.

import { createHash } from "node:crypto";
import { configString } from "../config.ts";
import { readCredential } from "./auth.ts";
import type { BenefitOutcome } from "../benefits.ts";

/** The public gateway, per region. The LLM gateway is a different host. */
const PUBLIC_GATEWAYS: Record<string, string> = {
  cn: "https://agent.minimaxi.com",
  en: "https://agent.minimax.io",
};

const STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
const CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";

/** Day states, as the official client reads them. */
export const SIGNIN_UPCOMING = 1;
export const SIGNIN_CLAIMABLE = 2;
export const SIGNIN_CLAIMED = 3;
export const SIGNIN_DISABLED = 4;

/** Claim results. */
export const CLAIM_CLAIMED = 1;
export const CLAIM_ALREADY_CLAIMED = 2;

export interface SigninDay {
  day_no: number;
  points: number;
  bonus_points?: number;
  status: number;
  is_today: boolean;
}

export interface SigninPanel {
  scene: number;
  days: SigninDay[];
}

export interface SigninClaim {
  claim_id: string;
  claim_result: number;
  day_no: number;
  points: number;
  expire_at_ms: number;
  panel?: SigninPanel;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** The client version the official client puts in the query string. */
const APP_VERSION = configString("MINIMAX_APP_VERSION", "5.2.0");
const REGION = configString("MINIMAX_REGION", "cn");

export function publicGatewayOrigin(region = REGION): string {
  return PUBLIC_GATEWAYS[region] ?? PUBLIC_GATEWAYS.cn;
}

/**
 * The request, built the way the official client builds it.
 *
 * The attribution headers (yy / x-timestamp / x-signature) are wire-protocol
 * constants shared by the first-party clients. They say "this request came
 * from a MiniMax client" — they are not credentials: the authorization is the
 * bearer token on the same request.
 */
function buildRequest(
  path: string,
  method: "GET" | "POST",
  token: string,
  userId: string,
  region: string,
  nowMs: number,
): { url: string; body?: string; headers: Record<string, string> } {
  const origin = publicGatewayOrigin(region);
  const url = new URL(`${origin}${path}`);
  const language = region === "en" ? "en" : "zh";
  url.search = new URLSearchParams({
    device_platform: "web",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    is_desktop: "1",
    desktop_version: APP_VERSION,
    unix: String(nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: language,
    lang: language,
    device_id: "0",
    os_name: process.platform,
    browser_name: "mcode",
    user_id: userId || "0",
    client: "mcode",
  }).toString();

  const body = method === "POST" ? "{}" : undefined;
  const signatureBody = body ?? "";
  const yyBody = body ?? "{}";
  const second = Math.floor(nowMs / 1000);
  const pathWithSearch = `${url.pathname}${url.search}`;
  return {
    url: url.toString(),
    body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "MiniMaxCode",
      Authorization: `Bearer ${token}`,
      yy: md5(`${encodeURIComponent(pathWithSearch)}_${yyBody}${md5(String(nowMs))}ooui`),
      "x-timestamp": String(second),
      "x-signature": md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${signatureBody}`),
    },
  };
}

/** The user id the official client asks for: GET /v1/api/user/info. */
async function fetchUserId(token: string, region: string): Promise<string> {
  const now = Date.now();
  const url = new URL(`${publicGatewayOrigin(region)}/v1/api/user/info`);
  const language = region === "en" ? "en" : "zh";
  url.search = new URLSearchParams({
    device_platform: "mcode",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(now),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: language,
    lang: language,
    device_id: "0",
    os_name: process.platform,
    browser_name: "mcode",
    user_id: "0",
    client: "mcode",
  }).toString();
  const second = Math.floor(now / 1000);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${token}`,
        "x-timestamp": String(second),
        "x-signature": md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
      },
    });
    const body: any = await res.json().catch(() => ({}));
    // `realUserID` is the account id the client sends in the query. The
    // other one, `userID`, is a different id -- sending it comes back as
    // "invalid timezone_id", because the platform looks the account's
    // timezone up by it.
    return String(body?.data?.userInfo?.realUserID ?? "");
  } catch {
    return "";
  }
}

export interface CheckinResult {
  status: number;
  body: any;
}

async function call(
  path: string,
  method: "GET" | "POST",
  token: string,
  userId: string,
  region: string,
): Promise<CheckinResult> {
  const request = buildRequest(path, method, token, userId, region, Date.now());
  try {
    const res = await fetch(request.url, {
      method,
      headers: request.headers,
      body: request.body,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { msg: (e as Error).message } };
  }
}

/** The sign-in panel of the account. */
export async function minimaxCheckinStatus(
  token: string,
  userId = "",
  region = REGION,
): Promise<{ status: number; panel: SigninPanel | null; raw: any }> {
  const res = await call(STATUS_PATH, "GET", token, userId, region);
  const panel = res.body?.data ?? null;
  return { status: res.status, panel, raw: res.body };
}

/** Claim the day that is claimable. */
export async function claimMiniMaxCheckin(
  token: string,
  userId = "",
  region = REGION,
): Promise<{ status: number; claim: SigninClaim | null; raw: any }> {
  const res = await call(CLAIM_PATH, "POST", token, userId, region);
  return { status: res.status, claim: res.body?.data ?? null, raw: res.body };
}

/** The day that can be claimed today, if there is one. */
export function claimableDay(panel: SigninPanel | null): SigninDay | null {
  if (!panel?.days?.length) return null;
  return panel.days.find((d) => d.status === SIGNIN_CLAIMABLE) ?? null;
}

/** Has today's sign-in already been claimed? */
export function claimedToday(panel: SigninPanel | null): boolean {
  if (!panel?.days?.length) return false;
  const today = panel.days.find((d) => d.is_today);
  return today?.status === SIGNIN_CLAIMED;
}

/**
 * How many days in a row.
 *
 * The panel is a seven-day cycle that starts today, so the days before today
 * are the ones already done. Counted backwards from today, the same way the
 * official client counts it.
 */
export function streak(panel: SigninPanel | null): number {
  if (!panel?.days?.length) return 0;
  const sorted = [...panel.days].sort((a, b) => a.day_no - b.day_no);
  const todayIndex = sorted.findIndex((d) => d.is_today);
  if (todayIndex < 0) return 0;
  const todayStatus = sorted[todayIndex]?.status;
  let index =
    todayStatus === SIGNIN_CLAIMED
      ? todayIndex
      : todayStatus === SIGNIN_CLAIMABLE
        ? todayIndex - 1
        : -1;
  if (index < 0) return 0;
  let count = 0;
  for (; index >= 0; index -= 1) {
    if (sorted[index]?.status !== SIGNIN_CLAIMED) break;
    count += 1;
  }
  return count;
}

export interface CreditLot {
  /** How much was given. */
  granted: number;
  /** How much of it is left. */
  remaining: number;
  /** How much was used. */
  consumed: number;
  /** When it was given. */
  grantedAtMs: number;
  /** When it runs out. */
  expireAtMs: number;
  /** 2 is the sign-in kind; the purchases are another one. */
  creditType: number;
}

/**
 * The credit ledger.
 *
 * This is where the sign-in points show up: the account balance
 * (`query_balance`) is about the money on the platform and reads zero for a
 * code account, while the ledger holds the points the sign-in gave.
 */
export async function fetchMiniMaxCredits(
  token: string,
  userId = "",
  region = REGION,
): Promise<CreditLot[]> {
  const res = await call("/minimax-cloud/api/v1/credit/details", "GET", token, userId, region);
  if (res.status !== 200) return [];
  const rows: any[] = Array.isArray(res.body?.details) ? res.body.details : [];
  return rows.map((row) => ({
    granted: Number(row?.granted_amount ?? 0),
    remaining: Number(row?.remaining_amount ?? 0),
    consumed: Number(row?.consumed_amount ?? 0),
    grantedAtMs: Number(row?.granted_at_ms ?? 0),
    expireAtMs: Number(row?.expire_at_ms ?? 0),
    creditType: Number(row?.credit_type ?? 0),
  }));
}

/**
 * The daily sign-in of the MiniMax Code account.
 *
 * The token is the account's own: the one the desktop app stored, or the one
 * this gateway logged in with. Both work — the platform only looks at the
 * bearer token.
 */
export async function runMiniMaxBenefits(providerId = "minimax"): Promise<BenefitOutcome> {
  const upstream = providerId;
  const report: string[] = [];
  let token = "";
  let region = REGION;
  try {
    const credential = await readCredential(false, providerId);
    token = credential.accessToken;
    region = credential.region || REGION;
  } catch {
    return {
      upstream,
      ok: false,
      credits: 0,
      report: ["未找到 MiniMax 登录态"],
      at: new Date().toISOString(),
    };
  }
  if (!token) {
    return {
      upstream,
      ok: false,
      credits: 0,
      report: ["未找到 MiniMax 登录态"],
      at: new Date().toISOString(),
    };
  }
  const userId = await fetchUserId(token, region);
  const status = await minimaxCheckinStatus(token, userId, region);
  if (status.status !== 200 || !status.panel) {
    report.push(`查签到状态失败（HTTP ${status.status}）`);
    return { upstream, ok: false, credits: 0, report, at: new Date().toISOString() };
  }
  const panel = status.panel;
  const days = panel.days?.length ?? 0;
  console.log(
    `[BENEFITS] ${upstream}: sign-in panel, ${days} day(s), scene ${panel.scene}` +
      (claimedToday(panel) ? ", today claimed" : claimableDay(panel) ? ", today claimable" : ""),
  );
  if (claimedToday(panel)) {
    report.push("今日已签到");
    report.push(`连签 ${streak(panel)} 天`);
    return { upstream, ok: true, credits: 0, report, at: new Date().toISOString() };
  }
  const day = claimableDay(panel);
  if (!day) {
    report.push("今天没有可签到的那一天");
    return { upstream, ok: true, credits: 0, report, at: new Date().toISOString() };
  }
  const claim = await claimMiniMaxCheckin(token, userId, region);
  if (claim.status !== 200 || !claim.claim) {
    report.push(`签到失败（HTTP ${claim.status}）`);
    return { upstream, ok: false, credits: 0, report, at: new Date().toISOString() };
  }
  if (claim.claim.claim_result === CLAIM_ALREADY_CLAIMED) {
    report.push("今日已领过");
    return { upstream, ok: true, credits: 0, report, at: new Date().toISOString() };
  }
  const points = Number(claim.claim.points ?? day.points ?? 0);
  const bonus = Number(day.bonus_points ?? 0);
  report.push(`签到 +${points} 点${bonus ? `（含奖励 ${bonus}）` : ""}`);
  report.push(`连签 ${streak(claim.claim.panel ?? panel)} 天`);
  return { upstream, ok: true, credits: points, report, at: new Date().toISOString() };
}
