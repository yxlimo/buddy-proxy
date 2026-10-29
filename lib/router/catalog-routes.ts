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
import { PLATFORMS, platformOf } from "../platforms.ts";
import { kindOf } from "../provider-kinds.ts";
import { accountsOfPlatform, listProviders } from "../providers.ts";
import { aggregateModels } from "../aggregate.ts";
import {
  aggregateAnthropicCatalog,
  aggregateCatalog,
  aggregateOpenAICatalog,
  groupCatalog,
  platformGroups,
  type AggregateEntry,
} from "./catalog.ts";
import { fetchWorkBuddyCatalog } from "../workbuddy/transport.ts";
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
  // The catalogue is the kind's, not a platform's: any logged-in account of any
  // WorkBuddy region can fetch it, and the first one that is on answers. Asking
  // only the China platform would leave a database with nothing but an
  // international account stuck on the bundled table for ever.
  const accounts = PLATFORMS.filter((template) => template.kind === "workbuddy")
    .flatMap((template) => enabledAccounts(template.id));
  if (!accounts.length) return;
  try {
    // The catalogue is the platform's, but the request that fetches it needs an
    // account's session: the first account that is on answers.
    // 库里那份不旧就不必问上游（传输层自己判）。
    const models = await fetchWorkBuddyCatalog(accounts[0].id, { force });
    if (models?.length) {
      console.log(`  [WORKBUDDY] catalogue: ${models.length} models`);
    }
  } catch (e) {
    console.warn(`[WORKBUDDY] catalogue refresh failed: ${(e as Error).message}`);
  }
}
/* ------------------------------------------------------------------ *
 * The platforms, as the router sees them
 * ------------------------------------------------------------------ */

/** A platform's accounts that are on, in weight order. */
export function enabledAccounts(platform: string) {
  return accountsOfPlatform(platform).filter((row) => row.enabled);
}

/** Does the platform have at least one account that is on? */
export function platformServing(platform: string): boolean {
  return enabledAccounts(platform).length > 0;
}

/** The platform's models. Without an account nobody can serve them, but the
 * catalogue is the platform's, not the account's. */
export function modelsOfPlatform(platform: string): string[] {
  const template = platformOf(platform);
  const kind = template ? kindOf(template.kind) : null;
  if (!kind) return [];
  const accounts = accountsOfPlatform(platform);
  if (!accounts.length) return [];
  return kind.models(accounts[0]).map((m) => m.id);
}

/**
 * Refresh the catalogues that come from the upstream itself.
 *
 * Three platforms publish their models live; the others ship a snapshot. The
 * fetch needs an account (a session or a key), so it goes account by account.
 */
function refreshLiveCatalogs(): void {
  for (const row of listProviders()) {
    if (!row.enabled) continue;
    if (row.kind === "workbuddy") void refreshWorkBuddyCatalog();
    if (row.kind === "sensenova") void refreshSenseNovaCatalog(false, row.id);
    if (row.kind === "intern-ai") void refreshInternAiCatalog(false, row.id);
  }
}
/**
 * The models the root route publishes.
 *
 * With nothing configured in the database this is every upstream's models under
 * their prefixed name — the list the root route always showed. Once the
 * database holds a model, the database is the catalog.
 */
function aggregateEntries(): AggregateEntry[] {
  return aggregateCatalog(platformGroups(), aggregateModels());
}

/** The published model a client asked for, if it is one of ours. */
export function findAggregate(id: string): AggregateEntry | undefined {
  if (!id) return undefined;
  return aggregateEntries().find((e) => e.id === id);
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
  const groups = platformGroups();
  const platform = String(ctx.params.platform ?? "");
  if (platform) {
    // The path names the platform; the models are the platform's, with the
    // real ids — the path already says where they live.
    ctx.body = groupCatalog(platform, groups, dialect === "openai");
    return;
  }
  // The root route publishes one list: the models the database says it
  // publishes. With nothing in the database there is no list to give.
  const entries = aggregateEntries();
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
