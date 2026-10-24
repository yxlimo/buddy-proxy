// lib/intern-ai/transport.ts — 推理端点与模型目录（Discovery 子站）。
//
// 两个子站里只有 Discovery（端砚）接进来了：它的推理端点讲 OpenAI 方言，
// 地址是 https://discovery-api.intern-ai.org.cn/v1，鉴权是一把 API key。
// Chat（浦语）是另一套方言，不在这条路上。
//
// 网关这一层做两件事：
//
//   1. 拿推理用的 key。账号上可能已经有了，没有就建一把 —— 完整的 key 只在
//      创建的那一次回答里出现（data.key），所以建它的那个函数必须负责把它
//      存起来（见 lib/intern-ai/keys.ts）。
//   2. 记着模型清单。清单跟着 key 走：不同的 key 能调的模型不一定一样。
//
// 额度不在这里：墨点是控制台的接口，见 lib/intern-ai/quota.ts。

import { AuthError } from "../credential.ts";
import { INTERN_AI_DISCOVERY_API_BASE, internAiDiscoveryKey } from "./config.ts";
import {
  loadSession,
  storedAccount,
  tokenFor,
  type InternAiSession,
} from "./auth.ts";
import { ensureApiKey } from "./keys.ts";
import {
  listDiscoveryConsoleModels,
  listDiscoveryModels,
  mergeCatalogModels,
  type InternAiCatalogModel,
} from "./models.ts";

/** 建 key 时用的名字。平台控制台上看得到这个名字。 */
const KEY_NAME = "buddy";

/** 清单最多放多久。模型清单变得不快，半小时问一次够了。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/** 新建的 key 要等多久才能用。平台上放行要一点时间。 */
const KEY_SETTLE_MS = 8_000;

/** 账号上现在有的 Discovery 推理 key（环境变量优先，其次数据库）。 */
export function internAiInferenceKey(providerId = "intern-ai"): string {
  const stored = storedAccount(providerId);
  return internAiDiscoveryKey(stored?.discoveryKey);
}

/**
 * 账号要用的推理 key，没有就建一把。
 *
 * 平台只把完整的 key 给一次，所以建它的那个函数负责把它存下来。登录之后调
 * 它，账号上就一定有能用的 key。
 */
export async function ensureInternAiKey(session: InternAiSession, providerId = "intern-ai"): Promise<string> {
  const token = tokenFor(session, "discovery");
  const stored = storedAccount(providerId);
  const key = await ensureApiKey(session, "discovery", token, KEY_NAME, stored?.discoveryKey ?? null, providerId);
  return key ?? "";
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/** 缓存的模型目录。 */
let catalog: InternAiCatalogModel[] = [];
let catalogAt = 0;

/** 现在这份目录。第一次问上游之前是空的。 */
export function internAiCatalog(): InternAiCatalogModel[] {
  return catalog;
}

/** 目录里的模型 id 集合。目录会变，所以每次现算。 */
export function internAiModelIds(): Set<string> {
  return new Set(catalog.map((m) => m.id));
}

/**
 * 问上游要模型目录，缓存在这里。
 *
 * 问的是推理端的清单（这把 key 真正能调的就是这些），再拿控制台在售的清单
 * 补上上下文长度与能力。控制台那份拿不到就用推理端那份 —— 少几个字段比一个
 * 空目录强。
 */
export async function refreshInternAiCatalog(force = false, providerId = "intern-ai"): Promise<void> {
  if (!force && catalog.length && Date.now() - catalogAt < CATALOG_TTL_MS) return;
  const key = internAiInferenceKey(providerId);
  if (!key) return;
  // 刚建出来的 key 不是马上就能用的：平台那边要把它放行，刚建完去问会被
  // 说「invalid API key」（HTTP 401）。等一会儿再问。
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const list = await listDiscoveryModels(key);
      const models = list.models;
      if (!models.length) return;
      let consoleModels: Awaited<ReturnType<typeof listDiscoveryConsoleModels>> = [];
      try {
        const session = loadSession(providerId);
        if (session) {
          consoleModels = await listDiscoveryConsoleModels(session, tokenFor(session, "discovery"));
        }
      } catch {
        // 控制台那一份拿不到就算了：推理端的清单是准的。
      }
      catalog = mergeCatalogModels(models, consoleModels);
      catalogAt = Date.now();
      return;
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (!message.includes("401") || attempt === 4) {
        console.warn(`[INTERN-AI] 模型目录刷新失败：${message}`);
        return;
      }
      console.log(`[INTERN-AI] 推理 key 还没生效（${attempt}/4），${KEY_SETTLE_MS / 1000}s 后再问`);
      await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 推理
 * ------------------------------------------------------------------ */

/**
 * 发一个请求到推理端点。
 *
 * 请求体是 OpenAI 形状的，原样发过去；答案也是 OpenAI 形状的，原样回来。
 */
export async function internAiChat(body: Record<string, any>, providerId = "intern-ai"): Promise<Response> {
  const key = internAiInferenceKey(providerId);
  if (!key) {
    throw new AuthError(
      "intern-ai has no inference key",
      "书生·端砚的账号上没有推理用的 API key。在面板里重新登录一次，网关会建一把。",
      500,
    );
  }
  const response = await fetch(`${INTERN_AI_DISCOVERY_API_BASE}/chat/completions`, {
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
      "intern-ai rejected the key",
      "书生·端砚拒绝了推理用的 API key（HTTP 401）。重新登录一次，网关会换一把。",
      502,
    );
  }
  return response;
}
