// lib/admin/credentials.ts — 凭据状态的词表。
//
// 各家上游各说各的（qoder 说 "authenticated"、minimax 说 "anonymous"、
// 面板的凭据表说 "usable"），面板要的是一套：契约里的 CredentialState 枚举。
//
// 词表只有这一处：字符串进来，枚举出去。反过来也有（契约里账号与凭据的
// status 仍是字符串），那是给人看的词。

import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { writeQiniuAccount } from "../qiniu/account.ts";
import { writeXinghuoKey } from "../xinghuo/account.ts";
import { writeOpenPlatformKey } from "../open-platform-credentials.ts";
import { writeSenseNovaKey } from "../sensenova/keys.ts";
import { writeInternAiKeys } from "../intern-ai/keys.ts";
import { writeTokenRhythmKey } from "../tokenrhythm/keys.ts";
import { quotaPluginOf } from "../quota-plugins.ts";
import { writePluginField } from "../quota-plugin-credentials.ts";
import { openPlatformOf, type OpenPlatformRow } from "../open-platforms.ts";
import { platformOf } from "../platforms.ts";
import { provider, providerKindOf } from "../providers.ts";

/**
 * 这个账号是不是开放平台的账号。
 *
 * 开放平台是用户自己加的平台（表里的那一行）。它的 kind 登记了（"openai"），
 * 但这里问的不是 kind：账号行说它属于哪个平台，那一行在平台表里、且不跟代码
 * 里的模板重名，就是开放平台。
 *
 * 表里有、代码里也有的 id 算模板：模板优先（lib/platforms.ts），那个账号不是
 * 开放平台的账号 —— 它按模板那一套算。
 */
export function openPlatformOfAccount(accountId: string): OpenPlatformRow | null {
  const row = provider(accountId);
  if (!row) return null;
  const open = openPlatformOf(row.platform);
  if (!open) return null;
  return platformOf(row.platform) === null ? open : null;
}

/**
 * 写一个账号的 API Key 列表。
 *
 * upstreamId 是账号行的 id：key 挂在账号下面，同一个平台下有两个账号时各写
 * 各的。
 *
 * 七牛云：推理用的 API key 与门户 cookie 两段。讯飞星火：一把推理用的 key。
 * 开放平台：一把推理用的 API key（位置就是第一个），后面几把按平台所选额度
 * 插件的 fields 顺序，一段一段写进插件要的那个位置。
 *
 * SenseNova：一把推理用的 key。书生·端砚：两把（Discovery 与 Chat）。TokenRhythm：
 * 一把推理用的 key。它们的位置都是顺序：第一把是推理用的 key，空的那把表示
 * 清掉它（与七牛云、讯飞星火一个意思）。
 *
 * 只改 key 那一格：账号、密码、会话原样留着（把它们清掉等于把登录态清了）。
 *
 * MiniMax Code 网关不收 key：它用登录的会话，套餐额度也跟着会话走。
 *
 * key 写在账号自己名下：面板写什么就是什么，环境变量不参与（它会在每次读的
 * 时候把自己写回数据库，删掉的账号转眼又有一把 key）。
 */
export function setProviderKeys(
  upstreamId: string,
  keys: string[],
): { ok: boolean; message: string; count: number } {
  // 开放平台的账号：第一把是推理用的 API key（空的那把表示清掉它），后面几把
  // 是额度插件要的那几段。这条先判：它看的是账号属于哪个平台，比「哪一类
  // 上游」更具体。
  const openPlatform = openPlatformOfAccount(upstreamId);
  if (openPlatform) {
    const plugin = quotaPluginOf(openPlatform.quotaPlugin?.trim() ?? "");
    const fields = plugin?.fields ?? [];
    // 数组比「推理 key + 插件要的那几段」短，说明调用方不知道这个插件要几段
    // （面板的插件登记表没到手时就会这样）。按位置写下去，缺的那几段会被当成
    // 空串清掉 —— 那是静默丢凭据。所以先判长度：不够就整单不改，不留半截。
    if (keys.length < 1 + fields.length) {
      return {
        ok: false,
        message: fields.length
          ? `${openPlatform.label}：额度插件要 ${fields.length} 段凭据（连推理 API key 一共要 ${1 + fields.length} 段），这次只发来 ${keys.length} 段：什么都没改。刷新页面再试。`
          : `${openPlatform.label}：要 1 段凭据（推理 API key），这次只发来 ${keys.length} 段：什么都没改。刷新页面再试。`,
        count: 0,
      };
    }
    // 位置就是顺序：第一把是推理用的 API key（它有自己的位置 :key），后面几把
    // 按平台所选插件的 fields 顺序，一段一段写进插件要的那个位置。空的那段表示
    // 清掉它（面板上重填一次就是替换的意思）。
    const apiKey = String(keys[0] ?? "").trim();
    let count = writeOpenPlatformKey(upstreamId, apiKey);
    const parts: string[] = [];
    if (apiKey) parts.push("API key");
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (writePluginField(upstreamId, field.name, String(keys[i + 1] ?? "").trim())) {
        count++;
        parts.push(field.label);
      }
    }
    // 平台没选插件（或插件没登记）却给了多于一把 key：多的那些没地方去，忽略
    // 掉，不报错 —— 用户可能刚改完插件，拦下来反而让人存不下去。
    let message = parts.length
      ? `写了${openPlatform.label}的 ${parts.join(" 与 ")}`
      : fields.length
        ? `清掉了${openPlatform.label}的凭据`
        : `清掉了${openPlatform.label}的 API key`;
    if (keys.length > 1 + fields.length) {
      message += plugin ? "（多余的 key 没写）" : "（这个平台没有额度插件，多余的 key 没写）";
    }
    return { ok: true, message, count };
  }
  const kind = providerKindOf(upstreamId);
  if (kind?.kind === "minimax" || upstreamId === "minimax") {
    // Code 网关只用会话：额度也走会话，没有要贴的 key。
    return {
      ok: false,
      message: "MiniMax Code 用登录的会话，不用 key（套餐额度也跟着会话走）。",
      count: 0,
    };
  }
  if (kind?.kind === "qiniu" || upstreamId === "qiniu") {
    // 七牛云的凭据有两段：推理用的 API key 与门户 cookie（额度只认 cookie）。
    // 位置就是顺序：第一段是 key，第二段是 cookie。空的那段表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const portalCookie = String(keys[1] ?? "").trim();
    const count = writeQiniuAccount(upstreamId, { apiKey, portalCookie });
    const message =
      count === 0
        ? "清掉了七牛云的凭据"
        : count === 2
          ? "写了 API key 与门户 cookie"
          : apiKey
            ? "只写了 API key（查不了额度）"
            : "只写了门户 cookie（不能推理）";
    return { ok: true, message, count };
  }
  if (kind?.kind === "xinghuo" || upstreamId === "xinghuo") {
    // 讯飞星火只有一把推理用的 API key：位置就是第一个。空的那把表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const count = writeXinghuoKey(upstreamId, apiKey);
    return {
      ok: true,
      message: count ? "写了讯飞星火的 API key" : "清掉了讯飞星火的 API key",
      count,
    };
  }
  if (kind?.kind === "sensenova" || upstreamId === "sensenova") {
    // SenseNova 只有一把推理用的 API key：位置就是第一个。空的那把表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const count = writeSenseNovaKey(upstreamId, apiKey);
    return {
      ok: true,
      message: count ? "写了 SenseNova 的 API key" : "清掉了 SenseNova 的 API key",
      count,
    };
  }
  if (kind?.kind === "intern-ai" || upstreamId === "intern-ai") {
    // 书生·端砚两把：位置 0 是 Discovery 的，位置 1 是 Chat 的。空的那把表示
    // 清掉它 —— Chat 的那把留着空不算错（网关推理走的是 Discovery）。
    const discoveryKey = String(keys[0] ?? "").trim();
    const chatKey = String(keys[1] ?? "").trim();
    const count = writeInternAiKeys(upstreamId, { discoveryKey, chatKey });
    const parts: string[] = [];
    if (discoveryKey) parts.push("Discovery key");
    if (chatKey) parts.push("Chat key");
    const message = parts.length
      ? `写了书生·端砚的 ${parts.join(" 与 ")}`
      : "清掉了书生·端砚的推理 key";
    return { ok: true, message, count };
  }
  if (kind?.kind === "tokenrhythm" || upstreamId === "tokenrhythm") {
    // TokenRhythm 只有一把推理用的 key：位置就是第一个。空的那把表示清掉它。
    const apiKey = String(keys[0] ?? "").trim();
    const count = writeTokenRhythmKey(upstreamId, apiKey);
    return {
      ok: true,
      message: count ? "写了 TokenRhythm 的 API key" : "清掉了 TokenRhythm 的 API key",
      count,
    };
  }
  // 别的平台没有「贴一把 key」这一步：它们的凭据各有各的形状。
  return { ok: false, message: `这个 Provider 不接受 API Key：${upstreamId}`, count: 0 };
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
 * 不同（一把 key 一个配额的是 key-1，账号密码是 account），所以认出它是
 * 哪一种要靠后缀。
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
  const base = hash >= 0 ? raw.slice(0, hash) : raw;
  const parts = base.split(":");
  if (parts[0] === "session" && parts[1] === "provider" && parts.length === 3) {
    const accountId = parts[2];
    return accountId ? { accountId, form: "session", tenant: null, derived } : null;
  }
  if (parts[0] === "key" && parts[1] === "provider" && parts.length === 4) {
    const accountId = parts[2];
    const suffix = parts[3];
    if (!accountId) return null;
    if (suffix === "account") return { accountId, form: "login", tenant: null, derived };
    const key = /^key-(\d+)$/.exec(suffix);
    if (key) return { accountId, form: "api_key", tenant: Number(key[1]), derived };
    return null;
  }
  return null;
}
