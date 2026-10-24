// lib/sensenova/transport.ts — 推理端点与模型目录。
//
// SenseNova 的推理端点讲 OpenAI 方言：请求发过去，答案原样回来。网关这一层
// 只做两件事：
//
//   1. 拿推理用的 key。账号上可能已经有（环境变量里，或者数据库里），没有就
//      在这里建一把 —— 平台只在创建的那一次回答里给完整值，所以建它的那个
//      函数必须负责把它存起来（见 lib/sensenova/keys.ts）。
//   2. 记着模型清单。清单是跟着 key 走的：不同的 key 能调的模型不一样。所以
//      它不是代码里的一张静态表，而是问上游要来的，缓存在这里。
//
// 额度不在这里：那是控制台的接口，见 lib/sensenova/quota.ts。

import { AuthError } from "../credential.ts";
import { SENSENOVA_INFER_BASE, senseNovaApiKey } from "./config.ts";
import { loadSession, storedAccount, type SenseNovaSession } from "./auth.ts";
import { ensureApiKey, KEY_TYPE_TOKEN_PLAN } from "./keys.ts";
import { listModels, type SenseNovaModel } from "./models.ts";

/** 建 key 时用的名字。平台控制台上看得到这个名字。 */
const KEY_NAME = "buddy";

/** 清单最多放多久。模型清单变得不快，半小时问一次够了。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/** 账号上现在有的推理 key（环境变量优先，其次数据库）。 */
export function senseNovaInferenceKey(providerId = "sensenova"): string {
  const stored = storedAccount(providerId);
  return senseNovaApiKey(stored?.apiKey);
}

/**
 * 账号要用的推理 key，没有就建一把。
 *
 * 平台只把完整的 key 给一次，所以建它的那个函数负责把它存下来。这里只是把
 * 那件事包一层：登录之后调它，账号上就一定有能用的 key。
 */
export async function ensureSenseNovaKey(session: SenseNovaSession, providerId = "sensenova"): Promise<string> {
  const stored = storedAccount(providerId);
  const key = await ensureApiKey(session, KEY_NAME, stored?.apiKey ?? null, KEY_TYPE_TOKEN_PLAN, providerId);
  return key ?? "";
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/** 缓存的模型清单。 */
let catalog: SenseNovaModel[] = [];
let catalogAt = 0;

/** 现在这份清单。第一次问上游之前是空的。 */
export function senseNovaCatalog(): SenseNovaModel[] {
  return catalog;
}

/** 清单里的模型 id 集合。目录会变，所以每次现算。 */
export function senseNovaModelIds(): Set<string> {
  return new Set(catalog.map((m) => m.id));
}

/**
 * 清单要 key：没有 key 就问不了（这个接口是给拿着 key 的调用方用的）。
 *
 * 账号上有会话却没有 key 的那种情况（老版本登录留下的），在这里补一把 ——
 * 免得面板上显示「已登录」但一个请求也发不出去。
 */
async function keyForCatalog(providerId = "sensenova"): Promise<string> {
  const key = senseNovaInferenceKey(providerId);
  if (key) return key;
  const session = loadSession(providerId);
  if (!session) return "";
  return ensureSenseNovaKey(session, providerId);
}

/**
 * 问上游要模型清单，缓存在这里。
 *
 * 问不到就留着上一次的那份：模型清单是给客户端看的，一个空的目录比一个过期
 * 的目录更没用。
 */
export async function refreshSenseNovaCatalog(force = false, providerId = "sensenova"): Promise<void> {
  if (!force && catalog.length && Date.now() - catalogAt < CATALOG_TTL_MS) return;
  const key = await keyForCatalog(providerId);
  if (!key) return;
  try {
    const models = await listModels(key);
    if (!models.length) return;
    catalog = models;
    catalogAt = Date.now();
  } catch (e) {
    console.warn(`[SENSENOVA] 模型清单刷新失败：${(e as Error)?.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 推理
 * ------------------------------------------------------------------ */

/**
 * 发一个请求到推理端点。
 *
 * 请求体是 OpenAI 形状的，原样发过去；答案也是 OpenAI 形状的，原样回来。
 * 上游报错了就把它的原话带回去 —— 平台自己的话比「上游失败了」有用。
 */
export async function senseNovaChat(body: Record<string, any>, providerId = "sensenova"): Promise<Response> {
  const key = senseNovaInferenceKey(providerId);
  if (!key) {
    throw new AuthError(
      "sensenova has no inference key",
      "SenseNova 账号上没有推理用的 API key。在面板里重新登录一次，网关会建一把。",
      500,
    );
  }
  const response = await fetch(`${SENSENOVA_INFER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: body.stream ? "text/event-stream" : "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status === 401) {
    throw new AuthError(
      "sensenova rejected the key",
      "SenseNova 拒绝了推理用的 API key（HTTP 401）。重新登录一次，网关会换一把。",
      502,
    );
  }
  return response;
}
