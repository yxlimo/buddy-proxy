// lib/router/catalog-routes.ts — the model catalogue: what a platform serves,
// and the /v1/models answer.
//
// A catalogue is the platform's, not the account's: it is the same list whoever
// pays for the request. Three platforms publish theirs live (WorkBuddy,
// SenseNova, 书生·端砚) and are fetched again in the background; the rest ship a
// snapshot that is read on the spot.
//
// The root route publishes one list — the models the database says it
// publishes. The prefixed route (`/qoder-cn/v1/models`) publishes the
// platform's own models under their real names.

import type Koa from "koa";
import { allPlatforms, OPEN_PLATFORM_KIND_NAME } from "../platforms.ts";
import { kindOf } from "../provider-kinds.ts";
import { listProviders } from "../providers.ts";
import { openPlatformOf } from "../open-platforms.ts";
import {
  openPlatformCatalogStale,
  refreshOpenPlatformCatalog,
} from "../open-platform-catalog.ts";
import { aggregateModels, type AggregateModel } from "../aggregate.ts";
import {
  aggregateAnthropicCatalog,
  aggregateCatalog,
  aggregateOpenAICatalog,
  groupCatalog,
  platformGroups,
  type AggregateEntry,
} from "./catalog.ts";
import { platformAvailabilities, platformAvailability, type PlatformAvailability } from "./availability.ts";
import { fetchWorkBuddyCatalog } from "../workbuddy/transport.ts";
import { regionOf, type WorkBuddyRegion } from "../workbuddy/auth.ts";
import { refreshSenseNovaCatalog } from "../sensenova/transport.ts";
import { refreshInternAiCatalog } from "../intern-ai/transport.ts";

// WorkBuddy's models are addressed by prefix only: several of them (glm-5.3,
// kimi-k2.8-preview) carry the same name as a Qoder model, so a bare name
// The catalogue itself lives in the database (lib/workbuddy/catalog-store.ts):
// the last one the upstream published, kept there whatever its age. The
// bundled table is only the bootstrap value — the catalogue a brand-new
// database starts with, before the upstream answers for the first time.
/** The upstream catalogue, refreshed when the one in the database is old. */
export async function refreshWorkBuddyCatalog(force = false): Promise<void> {
  // 目录是**区域**的，不是 kind 的：workbuddy.cn 和 workbuddy.ai 各自发布一份，
  // 两边几乎不重叠。所以每个区域都要自己去问一次，用自己区的一个账号；只问
  // 一个账号的话，另一个区永远拿不到自己的目录。
  const byRegion = new Map<WorkBuddyRegion, string>();
  for (const template of allPlatforms()) {
    if (template.kind !== "workbuddy") continue;
    const accounts = enabledAccounts(template.id);
    if (!accounts.length) continue;
    const region = regionOf(template.id);
    if (!byRegion.has(region)) byRegion.set(region, accounts[0].id);
  }
  for (const [region, providerId] of byRegion) {
    try {
      // 库里那份不旧就不必问上游（传输层自己判）。
      const models = await fetchWorkBuddyCatalog(providerId, { force });
      if (models?.length) {
        console.log(`  [WORKBUDDY] ${region} catalogue: ${models.length} models`);
      }
    } catch (e) {
      console.warn(`[WORKBUDDY] ${region} catalogue refresh failed: ${(e as Error).message}`);
    }
  }
}
/* ------------------------------------------------------------------ *
 * The platforms, as the router sees them
 * ------------------------------------------------------------------ */

/**
 * A platform's accounts that can serve a request, in weight order.
 *
 * 「能服务」是开着**而且**有可用凭据：账号建了但没填 key、没登录的，算不上。
 * 额度与冷却不管 —— 那两个说的是「现在接不了这个请求」。
 */
export function enabledAccounts(platform: string) {
  return platformAvailability(platform).serving;
}

/** Does the platform have at least one account that can serve a request? */
export function platformServing(platform: string): boolean {
  return enabledAccounts(platform).length > 0;
}

/** The platform's models. Without an account nobody can serve them, but the
 * catalogue is the platform's, not the account's: 额度用尽与冷却不摘模型。 */
export function modelsOfPlatform(platform: string): string[] {
  return platformAvailability(platform).ids;
}

/**
 * Refresh the catalogues that come from the upstream itself.
 *
 * Three platforms publish their models live; the open platforms publish theirs
 * too (the table row is what they answer); the others ship a snapshot. The
 * fetch needs an account (a session or a key), so it goes account by account.
 */
function refreshLiveCatalogs(): void {
  // 开放平台按平台记一次：名下有几个账号都一样，目录是平台的。
  const openPlatforms = new Set<string>();
  for (const row of listProviders()) {
    if (!row.enabled) continue;
    if (!kindOf(row.kind)) continue;
    if (row.kind === "workbuddy") void refreshWorkBuddyCatalog();
    if (row.kind === "sensenova") void refreshSenseNovaCatalog(false, row.id);
    if (row.kind === "intern-ai") void refreshInternAiCatalog(false, row.id);
    if (row.kind === OPEN_PLATFORM_KIND_NAME) openPlatforms.add(row.platform);
  }
  for (const platform of openPlatforms) {
    const row = openPlatformOf(platform);
    // 人写死的目录不动（那是明确的意思，不是默认值）；刚拉过的也不必再问上游
    // —— 目录刷新在请求路径上，每个请求都问一次上游是白花钱。
    if (!row?.models.auto || !openPlatformCatalogStale(row)) continue;
    // 拉目录是后台的事：不等它，答复不能被上游的慢拖住。
    //
    // 双保险：refreshOpenPlatformCatalog 自己不 reject（库开不了、SQLITE_BUSY
    // 都归一成 { ok: false }），这里再兜一层 —— 请求路径上一个没人接的
    // rejection 就是一次未处理的 rejection（Node 当它致命）。
    //
    // 拉不到的那一行告警由目录自己写（lib/open-platform-catalog.ts），这里不
    // 重复：同一次失败只留一行，两处都写就是刷屏。
    void refreshOpenPlatformCatalog(platform).catch(() => {
      /* 目录自己记了告警，这里只保证不 reject */
    });
  }
}
/**
 * The models the root route publishes.
 *
 * With nothing configured in the database this is every upstream's models under
 * their prefixed name — the list the root route always showed. Once the
 * database holds a model, the database is the catalog.
 */
function aggregateEntries(availabilities?: Map<string, PlatformAvailability>): AggregateEntry[] {
  return aggregateCatalog(platformGroups(availabilities), aggregateModels());
}

/** The published model a client asked for, if it is one of ours. */
export function findAggregate(
  id: string,
  availabilities?: Map<string, PlatformAvailability>,
): AggregateEntry | undefined {
  if (!id) return undefined;
  return aggregateEntries(availabilities).find((e) => e.id === id);
}

/**
 * The published model by id — the one the database says exists.
 *
 * 根路由先问这个：模型名写错的请求不该去读账号表与冷却表（那些表只有真的要
 * 判定「这个平台能不能接」时才要读）。没发布过的模型到这里就是 null。
 */
export function publishedModel(id: string): AggregateModel | null {
  if (!id) return null;
  return aggregateModels().find((m) => m.id === id) ?? null;
}

/**
 * `GET /v1/models`, with or without the platform in the path.
 *
 * The upstream's catalogue is the source of truth; it is fetched in the
 * background so this answer is never blocked by it.
 */
export function serveModels(ctx: Koa.Context): void {
  const dialect = String(ctx.query.dialect ?? "").toLowerCase();
  refreshLiveCatalogs();
  // allPlatforms() 每次调用读一次 platform 表（开放平台在那张表里）。
  const availabilities = platformAvailabilities(allPlatforms());
  const groups = platformGroups(availabilities);
  const platform = String(ctx.params.platform ?? "");
  if (platform) {
    // The path names the platform; the models are the platform's, with the
    // real ids — the path already says where they live.
    ctx.body = groupCatalog(platform, groups, dialect === "openai");
    return;
  }
  // The root route publishes one list: the models the database says it
  // publishes. With nothing in the database there is no list to give.
  const entries = aggregateEntries(availabilities);
  if (!entries.length) {
    ctx.status = 404;
    ctx.body = {
      error: { type: "invalid_request_error", message: "no published models" },
      hint: "根路由还没有发布任何模型。在面板里配置并保存后生效。",
    };
    return;
  }
  ctx.body = dialect === "openai" ? aggregateOpenAICatalog(entries) : aggregateAnthropicCatalog(entries);
}
