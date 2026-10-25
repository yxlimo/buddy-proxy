// lib/sensenova/keys.ts — 账号的 API key。
//
// 控制台里有两种 key，各走各的接口：
//
//   订阅模式（积分池）   {platform}/lite/console/v1/metered/api-keys
//                        body 里的 key_type = API_KEY_TYPE_TOKEN_PLAN
//   按量计费             同一个接口
//                        body 里的 key_type = API_KEY_TYPE_METERED
//
// key_type 就是「用哪一类的额度」：TOKEN_PLAN 走积分池（分池、分窗口），
// METERED 走按量计费（按调用量算钱）。这是唯一能指定的地方——池子本身不
// 在 key 上选，池子由「调哪个模型」决定：Flash-Lite 系列先扣专属池，
// 其余模型只扣通用池。详见 lib/sensenova/quota.ts。
//
// key_type 省略时，平台按控制台默认给（我们这边显式写死，免得平台改默认）。
//
// 完整的 key 只在创建的那一次回答里出现（api_key_plain），列表里永远是
// 掩码。所以创建它的那个函数必须负责把它存起来。

import { consoleApi } from "./platform.ts";
import { listModels } from "./models.ts";
import { senseNovaApiKey } from "./config.ts";
import { setSecret } from "../store.ts";
import { accountId, storedAccount, type SenseNovaSession } from "./auth.ts";
import type { PlatformKey, PlatformKeys } from "../platform-keys.ts";

/** key 的两种计费类型。 */
export type SenseNovaKeyType = "API_KEY_TYPE_TOKEN_PLAN" | "API_KEY_TYPE_METERED";

/** 订阅模式：走积分池。 */
export const KEY_TYPE_TOKEN_PLAN: SenseNovaKeyType = "API_KEY_TYPE_TOKEN_PLAN";

/** 按量计费：按调用量算钱。 */
export const KEY_TYPE_METERED: SenseNovaKeyType = "API_KEY_TYPE_METERED";

/** 一个 key。 */
export interface SenseNovaApiKey {
  id: string;
  /** 人起的名字。 */
  displayname: string;
  /** 计费类型。 */
  keyType: string;
  /** 掩码后的 key（列表里就是这个）。 */
  maskedKey: string;
  /** 完整的 key：只有创建的时候才有。 */
  plainKey?: string;
  createTime: string | null;
  status: string;
  isDefault: boolean;
}

/** 把接口返回的一行读成 key。 */
export function parseApiKeyRow(row: any): SenseNovaApiKey {
  const key = String(row?.api_key ?? "");
  return {
    id: String(row?.id ?? ""),
    displayname: String(row?.displayname ?? ""),
    keyType: String(row?.key_type ?? ""),
    // 短 key 不掩码——掩了就没法认了。
    maskedKey: key.length > 8 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : key,
    plainKey: row?.api_key_plain ? String(row.api_key_plain) : undefined,
    createTime: row?.create_time ?? null,
    status: String(row?.status ?? ""),
    isDefault: row?.is_default === true,
  };
}

/**
 * 账号现有的 key。
 *
 * 面板还没做 key 管理：这一族接口是前瞻代码，现在只有网关自己与探针在用。
 */
export async function listApiKeys(session: SenseNovaSession, pageSize = 20): Promise<SenseNovaApiKey[]> {
  const data = await consoleApi<any>("/console/v1/metered/api-keys", session, {
    query: { page_size: pageSize },
  });
  const rows = Array.isArray(data?.api_keys) ? data.api_keys : [];
  return rows.map(parseApiKeyRow);
}

/**
 * 建一个 key。
 *
 * 完整的 key 在回答里的 api_key_plain，列表里以后只有掩码，所以拿到的
 * 时候要马上存。
 */
export async function createApiKey(
  session: SenseNovaSession,
  name: string,
  keyType: SenseNovaKeyType = KEY_TYPE_TOKEN_PLAN,
): Promise<SenseNovaApiKey> {
  const data = await consoleApi<any>("/console/v1/metered/api-keys", session, {
    method: "POST",
    body: { displayname: name, key_type: keyType },
  });
  const row = data?.api_key ?? data;
  const key = parseApiKeyRow({ ...row, api_key_plain: data?.api_key_plain });
  return key;
}

/** 注销一个 key。 */
export async function revokeApiKey(session: SenseNovaSession, id: string): Promise<void> {
  await consoleApi<any>(`/console/v1/metered/api-keys/${encodeURIComponent(id)}`, session, {
    method: "DELETE",
  });
}

/**
 * 新建的 key 在推理端点上不是立刻就能用的。
 *
 * 实测：刚建好的那把 key 打 {base}/models 会得到 401 Forbidden；过十来秒再
 * 打就好了。平台建 key 和推理端点认 key 不是同一件事，中间有一段传播时间。
 *
 * 所以这里轮询一下，别让调用方拿着一个还没生效的 key 去发请求。
 */
export async function waitForKeyUsable(
  apiKey: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 3000;
  for (let i = 0; i < attempts; i++) {
    try {
      await listModels(apiKey);
      return true;
    } catch {
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * 账号要用的 key。
 *
 * 谁优先：显式传进来的 > 环境变量里的 > 数据库里的 > 平台新建的。
 * 换过的 key 得算数，所以前三种都算数；只有都没有的时候才去平台建一个，
 * 而且建完必须马上存——完整的 key 只在创建的那一次回答里出现。
 */
export async function ensureApiKey(
  session: SenseNovaSession,
  name: string,
  current?: string | null,
  keyType: SenseNovaKeyType = KEY_TYPE_TOKEN_PLAN,
  providerId = "sensenova",
): Promise<string | null> {
  const stored = storedAccount(providerId);
  const existing = current ?? senseNovaApiKey(stored?.apiKey) ?? "";
  if (existing) return existing;
  const created = await createApiKey(session, name, keyType);
  if (!created.plainKey) {
    throw new Error("平台创建了 key，但没有把完整的 key 交回来");
  }
  setSecret(accountId(providerId), "account", { ...stored, apiKey: created.plainKey });
  console.log(`[SENSENOVA] 新建的 key：${created.displayname}（${created.keyType}）`);
  // 存下来了，但推理端点可能还没认它。等一下，省得下一个请求就撞 401。
  const usable = await waitForKeyUsable(created.plainKey);
  if (!usable) {
    console.log("[SENSENOVA] 新建的 key 在推理端点上还没生效，稍后重试即可");
  }
  return created.plainKey;
}

/** 一把 key，换成三家平台共同的形状。 */
function toPlatformKey(key: SenseNovaApiKey): PlatformKey {
  return {
    id: key.id,
    name: key.displayname,
    masked: key.maskedKey,
    plain: key.plainKey,
    status: key.status,
  };
}

/** 建 key 时用的名字。平台控制台上看得到这个名字。 */
export const SENSE_NOVA_KEY_NAME = "buddy";

/**
 * SenseNova 的 key 管理，三家平台统一的形状。
 *
 * 平台的接口在实现里（控制台那套 metered api-keys）；这里只是把它包的形状
 * 换成三家一样的那种。面板还没做这个操作：现在只有网关自己在用 ensure。
 */
export const senseNovaKeys: PlatformKeys<SenseNovaSession> = {
  what: "SenseNova",
  list: async ({ session }) => (await listApiKeys(session)).map(toPlatformKey),
  create: async ({ session, keyType }, name) =>
    toPlatformKey(
      await createApiKey(session, name, (keyType as SenseNovaKeyType) ?? KEY_TYPE_TOKEN_PLAN),
    ),
  delete: async ({ session }, id) => {
    await revokeApiKey(session, id);
  },
  ensure: async ({ session, keyType, providerId }, current) =>
    ensureApiKey(
      session,
      SENSE_NOVA_KEY_NAME,
      current ?? null,
      (keyType as SenseNovaKeyType) ?? KEY_TYPE_TOKEN_PLAN,
      providerId ?? "sensenova",
    ),
};

