// lib/sensenova/transport.ts — 推理端点与模型目录。
//
// SenseNova 的推理端点讲 OpenAI 方言：请求发过去，答案原样回来。网关这一层
// 只做两件事：
//
//   1. 拿推理用的 key。账号上那把是用户自己填的（面板上的 setProviderKeys），
//      没有就是没有 —— 网关不替人建一把（平台只在创建的那一次回答里给完整
//      值，建出来的那把用户既看不到也换不掉）。
//   2. 记着模型清单。清单是跟着 key 走的：不同的 key 能调的模型不一样。所以
//      它不是代码里的一张静态表，而是问上游要来的，缓存在这里。
//
// 额度不在这里：那是控制台的接口，见 lib/sensenova/quota.ts。

import { SENSENOVA_INFER_BASE, senseNovaApiKey } from "./config.ts";
import { storedAccount } from "./auth.ts";
import { listModels, type SenseNovaModel } from "./models.ts";
import { CatalogCache } from "../router/catalog-cache.ts";
import { openAiPlatformChat } from "../router/openai-platform.ts";

/** 清单最多放多久。模型清单变得不快，半小时问一次够了。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/** 账号上现在有的推理 key（就在这个账号名下）。 */
export function senseNovaInferenceKey(providerId = "sensenova"): string {
  const stored = storedAccount(providerId);
  return senseNovaApiKey(stored?.apiKey);
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/**
 * 缓存的模型清单。落库一份：重启后手上就有目录，这个平台不会从模型列表里
 * 整组消失（目录空 = 平台不可见 = 路由不到）。
 *
 * platform 是这份清单要去的那一行：目录现在由平台行说了算（各 kind 的 models()
 * 读它），上游这份到手时要同步过去，否则面板与路由里一直是空的。
 */
const catalog = new CatalogCache<SenseNovaModel>(CATALOG_TTL_MS, {
  cacheId: "sensenova:catalog",
  platform: "sensenova",
});

/** 现在这份清单。第一次问上游之前是空的。 */
export function senseNovaCatalog(): SenseNovaModel[] {
  return catalog.list();
}

/** 清单里的模型 id 集合。目录会变，所以每次现算。 */
export function senseNovaModelIds(): Set<string> {
  return new Set(senseNovaCatalog().map((m) => m.id));
}

/**
 * 问上游要模型清单，缓存在这里。
 *
 * 清单要 key：没有 key 就问不了（这个接口是给拿着 key 的调用方用的）。key 是
 * 用户自己填的：账号上没有 key 的那种账号（老版本登录留下的），网关不替它
 * 建一把 —— 面板上填一把就行了。
 *
 * 问不到就留着上一次的那份：模型清单是给客户端看的，一个空的目录比一个过期
 * 的目录更没用。
 */
export async function refreshSenseNovaCatalog(force = false, providerId = "sensenova"): Promise<void> {
  if (!catalog.stale(force)) return;
  const key = senseNovaInferenceKey(providerId);
  if (!key) return;
  try {
    const models = await listModels(key);
    catalog.update(models);
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
export async function senseNovaChat(
  body: Record<string, unknown>,
  providerId = "sensenova",
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return openAiPlatformChat(
    {
      id: "sensenova",
      label: "SenseNova",
      base: SENSENOVA_INFER_BASE,
      key: senseNovaInferenceKey(providerId),
    },
    body,
    extraHeaders,
    signal,
  );
}
