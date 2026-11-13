// lib/admin/credentials.ts — 凭据状态的词表。
//
// 各家上游各说各的（qoder 说 "authenticated"、minimax 说 "anonymous"、
// 面板的凭据表说 "usable"），面板要的是一套：契约里的 CredentialState 枚举。
//
// 词表只有这一处：字符串进来，枚举出去。反过来也有（契约里账号与凭据的
// status 仍是字符串），那是给人看的词。

import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { openPlatformOf, OPEN_PLATFORM_KIND_NAME, type OpenPlatformRow } from "../open-platforms.ts";
import { isSimulatedClientKind } from "../platform-catalog.ts";
import { platformOfAny } from "../platforms.ts";
import { credentialsOfKind, kindOf } from "../provider-kinds.ts";
import { provider, providerKindOf } from "../providers.ts";
// 失败的机器码与排查用的事实。文案在面板那一侧。
import type { AdminResult } from "./error-codes.ts";

/**
 * 这个账号是不是开放平台的账号。
 *
 * 开放平台是用户自己加的平台（表里的那一行）。模拟客户端那一族也有平台行，但
 * 它们靠登录拿会话，不归“填几格 key”这一档 —— 按 kind 分开。
 *
 * 有自己那一类凭据形状的开放平台不算「开放平台」这一档：七牛云要两段（推理
 * key 与门户 cookie），书生·端砚要两段，其余三家各一把。它们凭 kind 分流到
 * 各自的那一档去 —— 这一档（通用开放平台）是一把推理 key 加额度插件要的那几
 * 段，段数与位置都不一样。
 */
export function openPlatformOfAccount(accountId: string): OpenPlatformRow | null {
  const row = provider(accountId);
  if (!row) return null;
  const open = openPlatformOf(row.platform);
  if (!open) return null;
  if (isSimulatedClientKind(open.kind)) return null;
  return GENERIC_OPEN_PLATFORM_KINDS.has(open.kind) ? open : null;
}

/**
 * 凭据形状是「一把推理 key，加上额度插件要的那几段」的那几类开放平台。
 *
 * openai 与 anthropic 只差报文方言，凭据完全一样（同一把 x-api-key），所以
 * 它们走同一档，各写一份就是两份知识。名字分别住在 lib/kinds/openai.ts 与
 * lib/kinds/anthropic.ts；这里写成字面量是因为那一层会把转发层（lib/router/）
 * 拖进来，反过来引它就成了环。
 */
const GENERIC_OPEN_PLATFORM_KINDS: ReadonlySet<string> = new Set([
  OPEN_PLATFORM_KIND_NAME,
  "anthropic",
]);

/**
 * 这个账号（或那个平台）属于哪一类上游。
 *
 * 账号行说了算；账号行不在（面板上拿到的是平台 id）就按平台 id 认 —— 第一个
 * 账号的 id 就是平台 id，这一路不是猜类别，是查平台。
 */
function kindNameOf(upstreamId: string): string {
  return providerKindOf(upstreamId)?.kind ?? platformOfAny(upstreamId)?.kind ?? "";
}

/**
 * 写一个账号的 API Key 列表。
 *
 * upstreamId 是账号行的 id：key 挂在账号下面，同一个平台下有两个账号时各写各
 * 的。
 *
 * 要几段、各叫什么、按什么顺序写，全由种类的凭据声明说（
 * lib/provider-kinds.ts 的 CredentialPlan）：面板上那几格是同一份声明算出来
 * 的，所以「面板发上来几段」与「这边按位置收几段」不会各说各的。
 *
 * 只改 key 那几格：账号、密码、会话原样留着（把它们清掉等于把登录态清了）。
 *
 * key 写在账号自己名下：面板写什么就是什么，环境变量不参与（它会在每次读的
 * 时候把自己写回数据库，删掉的账号转眼又有一把 key）。
 */
export function setProviderKeys(
  upstreamId: string,
  keys: string[],
): AdminResult & { count: number } {
  const row = provider(upstreamId);
  const kind = row?.kind ?? kindNameOf(upstreamId);
  const plan = credentialsOfKind(kind);
  // 账号行多半在；不在的时候（面板把平台 id 交回来）按「平台 id 就是它第一个
  // 账号的 id」这个约定凑一份 —— 凭据的 id 与形状都只看 id 与种类。
  const owner = row ?? { id: upstreamId, platform: upstreamId, kind };
  const fields = plan.fields(owner);
  if (!fields.length) {
    // 这一类不收 key：说得出的说缘故（登录型的那几家），说不出的按「这个账号没
    // 有 key 可写」办；连账号都没有就是查错了 id。
    if (plan.noKeyNote) {
      return {
        ok: false,
        code: "ACCOUNT_TAKES_NO_KEY",
        message: `account ${upstreamId} is ${kind}: ${plan.noKeyNote}`,
        count: 0,
      };
    }
    return row
      ? {
          ok: false,
          code: "ACCOUNT_TAKES_NO_KEY",
          message: `account ${upstreamId} is ${row.kind}: it has no api key to write`,
          count: 0,
        }
      : { ok: false, code: "ACCOUNT_NOT_FOUND", message: `no account ${upstreamId}`, count: 0 };
  }
  // 段数到运行时才知道的平台（开放平台：由额度插件决定）：数组比声明要的段数
  // 短，说明调用方不知道这个平台要几段（面板的插件登记表没到手时就会这样）。
  // 按位置写下去，缺的那几段会被当成空串清掉 —— 那是静默丢凭据。所以先判长度：
  // 不够就整单不改，不留半截。段数定死的种类不判：空数组就是「都清掉」。
  if (plan.dynamicFields && keys.length < fields.length) {
    return {
      ok: false,
      code: "ACCOUNT_KEY_COUNT_SHORT",
      message:
        `account ${upstreamId} takes ${fields.length} keys (${fields.map((f) => f.label).join(" + ")}), ` +
        `got ${keys.length}: nothing written`,
      count: 0,
    };
  }
  const count = plan.write(owner, keys);
  const written = fields.filter((_, i) => String(keys[i] ?? "").trim()).map((f) => f.label);
  const name = plan.name?.(owner) ?? kindOf(kind)?.label ?? kind;
  let message = written.length
    ? `已保存${name}的 ${written.join(" 与 ")}`
    : `已清除${name}的凭据`;
  if (written.length && written.length < fields.length) {
    message += `（还有 ${fields.length - written.length} 段没填）`;
  }
  if (keys.length > fields.length) message += "（多余的 key 未保存）";
  return { ok: true, message, count };
}

/**
 * 上游报的状态 → 契约里的枚举。
 *
 * "usable" 是面板自己的说法：这条凭据能用。
 * "anonymous" 在**上游**那里是「没登录」的意思（qoder、workbuddy、minimax
 * 都这么报），所以上游的 anonymous 要算「没有凭据」—— 那是
 * `fromUpstreamStatus` 那里单独判的。这里的 anonymous 是「有凭据，但还没
 * 过期」—— 账号密码型上游（TokenRhythm）的常态。
 */
export function credentialState(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      return CredentialState.ANONYMOUS;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

/**
 * 枚举 → 面板账号与凭据表里的那个词。
 *
 * 契约里 Account.status 与 Credential.status 仍是字符串（usable / expired /
 * missing），所以这里把枚举换成人能读的词。
 */
export function credentialStateText(state: CredentialState): string {
  switch (state) {
    case CredentialState.AUTHENTICATED:
    case CredentialState.ANONYMOUS:
    case CredentialState.USABLE:
      return "usable";
    case CredentialState.EXPIRED:
      return "expired";
    case CredentialState.ERROR:
      return "error";
    default:
      return "missing";
  }
}

/** 这个状态算「有能用的凭据」吗。 */
export function hasUsableCredential(state: CredentialState): boolean {
  return (
    state === CredentialState.AUTHENTICATED ||
    state === CredentialState.ANONYMOUS ||
    state === CredentialState.USABLE
  );
}

/* ------------------------------------------------------------------ *
 * 凭据的 id
 * ------------------------------------------------------------------ */

/**
 * 一条凭据 id 的形状。
 *
 * 凭据的 id 就是它在数据库里的地址（见 lib/providers.ts 的 providerSecretId）：
 * 会话是 session:provider:<账号>，钥匙是 key:provider:<账号>:<后缀>。后缀各家
 * 不同（通用开放平台是 key，账号密码类的是 account），所以认出它是哪一种要靠
 * 后缀。
 *
 * 后缀没有「任意」那一档：认不出来就是不认识这条凭据，不猜。
 *
 * 账号就是 provider 表那一行的 id —— 账号模型里一行一个登录，所以凭据的 id
 * 里没有比账号更细的东西。
 */
export interface CredentialRef {
  /** 它属于哪个账号：provider 表里那一行的 id。 */
  accountId: string;
  /** session / api_key / login。 */
  form: string;
  /** 第几把 key：只有一把 key 一个配额的那种形状才有。 */
  tenant: number | null;
  /** 从账号里派生出来的那一条：api_key、discovery_key。 */
  derived: string;
}

/**
 * 把凭据的 id 读成它指向的东西。
 *
 * 面板把凭据的 id 原样交回来（「试一下」「刷新一下」），所以这里是唯一的算法：
 * 认不出来的 id 就是不认识的凭据，不会去猜。
 */
export function parseCredentialId(id: string): CredentialRef | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  // 派生出来的那一条用 # 记：账号是它来的地方，值是账号里取的那个。
  const hash = raw.indexOf("#");
  const derived = hash >= 0 ? raw.slice(hash + 1) : "";
  const parts = (hash >= 0 ? raw.slice(0, hash) : raw).split(":");
  if (parts[0] === "session" && parts[1] === "provider" && parts.length === 3) {
    const accountId = parts[2];
    return accountId ? { accountId, form: "session", tenant: null, derived } : null;
  }
  if (parts[0] !== "key" || parts[1] !== "provider" || parts.length !== 4) return null;
  const accountId = parts[2];
  const suffix = parts[3];
  if (!accountId) return null;
  if (suffix === "account") return { accountId, form: "login", tenant: null, derived };
  // 通用开放平台那一把推理 key 就存在这一个后缀上（lib/open-platform-credentials.ts）。
  // 认不出它的话，面板上那一行的「试一下」会回一句「无法识别的凭据」。
  if (suffix === "key") return { accountId, form: "api_key", tenant: null, derived };
  const key = /^key-(\d+)$/.exec(suffix);
  return key ? { accountId, form: "api_key", tenant: Number(key[1]), derived } : null;
}
