// lib/admin/service.ts — 管理接口的 33 个方法。
//
// 数据都从已有的地方取：配置在 lib/config.ts，公布的模型在 lib/aggregate.ts，
// 权益在 lib/benefits.ts，凭据与余额在 lib/admin/accounts.ts 与
// lib/admin/upstreams.ts，用量在 lib/admin/usage.ts。这里只做一件事：把它们
// 摆成契约里的形状。
//
// 契约在 proto/buddy/admin/v1/admin.proto，生成物在 lib/gen/。改契约之后跑
// `mise run proto` 重新生成，这里跟着改。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AccountSchema,
  AdminService,
  BalanceLotSchema,
  AddAccountResponseSchema,
  AddPlatformResponseSchema,
  BalanceSummarySchema,
  BeginLoginResponseSchema,
  BenefitStatusSchema,
  CancelLoginResponseSchema,
  CatalogModelSchema,
  ConfigItemSchema,
  CredentialSchema,
  CredentialStatusSchema,
  CreditLotSchema,
  CreditSummarySchema,
  DeleteAccountResponseSchema,
  DeletePlatformResponseSchema,
  DeletePublishedModelResponseSchema,
  ExchangeLoginCodeResponseSchema,
  GetBalanceResponseSchema,
  GetBenefitStatusResponseSchema,
  GetLoginStatusResponseSchema,
  GetSystemStatusResponseSchema,
  GetUsageSummaryResponseSchema,
  ImportLoginTokenResponseSchema,
  ListAccountsResponseSchema,
  ListConfigResponseSchema,
  CredentialFieldSchema,
  ListProviderKindsResponseSchema,
  ProviderKindSchema,
  ListCredentialsResponseSchema,
  ListModelsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListPlatformKindsResponseSchema,
  ListModelOverridesResponseSchema,
  EffortListSchema,
  SetModelOverridesResponseSchema,
  DeleteModelOverrideResponseSchema,
  ModelOverrideSchema,
  ModelBillingSchema,
  PlatformKindSchema,
  ListUpstreamsResponseSchema,
  ListUsageEventsResponseSchema,  LoginSessionSchema,
  LoginWithPasswordResponseSchema,
  PublishedModelSchema,
  ModelMetadataSchema,
  OpenPlatformSchema,
  PublishedTargetSchema,
  QuotaPluginFieldSchema,
  QuotaPluginSchema,
  RefreshCredentialResponseSchema,
  RefreshPlatformModelsResponseSchema,
  SetProviderKeysResponseSchema,
  RestartSystemResponseSchema,
  RunBenefitNowResponseSchema,
  SavePublishedModelResponseSchema,
  SetConfigResponseSchema,
  SetPlatformPolicyResponseSchema,
  SetAccountEnabledResponseSchema,
  TailLogResponseSchema,
  TestCredentialResponseSchema,
  LogoutAccountResponseSchema,
  UpdatePlatformResponseSchema,
  UpdateProviderResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  type UpstreamQuota,
  type ModelOverride,
  UsageBucketSchema,
  UsageEventSchema,
  UsageSummarySchema,
} from "../gen/buddy/admin/v1/admin_pb.ts";
import { adminTokenSet } from "./token.ts";
// 计费的形状在 lib/catalog-billing.ts 一处定：这一层只把它摆成契约里的样子。
import type { ModelBilling } from "../catalog-billing.ts";
import { configItems, knownConfigKeys, pendingRestart, setConfigValue } from "./config.ts";
import {
  freshHealthSnapshot,
  healthSnapshot,
  setAccountEnabled,
  upstreamQuota,
  upstreamQuotas,
  upstreamAccountCount,
  upstreamBaseUrl,
  upstreamCredential,
  upstreamCredentialOf,
  upstreamModelCount,
  upstreamPolicy,
  upstreamRegion,
  upstreamState,
  upstreamStateOf,
  upstreamCooling,
  type HealthSnapshot,
  type QuotaView,
  type UpstreamId,
} from "./upstreams.ts";
import { platformAvailabilities, type PlatformAvailability } from "./platform-state.ts";
import { adminError } from "./error-codes.ts";
import { coolingOf } from "./upstream-state.ts";
import {
  deleteAccount,
  listAccounts,
  listCredentials,
  logoutAccount,
  refreshCredential,
  testCredential,
  type AccountView,
} from "./accounts.ts";
import { credentialStateText, setProviderKeys } from "./credentials.ts";
import {
  beginLogin,
  cancelLogin,
  exchangeLoginCode,
  getLoginStatus,
  importLoginToken,
  loginWithPassword,
  type StoredLogin,
} from "./login.ts";
import { catalogModels, deletePublishedModel, publishedModels, savePublishedModel } from "./models.ts";
import {
  deleteModelOverride,
  listModelOverrides,
  upsertModelOverrides,
  type ModelOverrideRow,
} from "../model-overrides.ts";
import {
  accountsOfPlatform,
  addAccount,
  listProviders,
  provider,
  updateProvider,
  type ProviderRow,
} from "../providers.ts";
import {
  createOpenPlatform,
  deleteOpenPlatform,
  listOpenPlatforms,
  openPlatformOf,
  updateOpenPlatform,
  type OpenPlatformRow,
} from "../open-platforms.ts";
import { refreshOpenPlatformCatalog } from "../open-platform-catalog.ts";
import { isSimulatedClientKind, platformKindChoices } from "../platform-catalog.ts";
import { allQuotaPlugins } from "../quota-plugins.ts";
import { quotaConclusionOf, quotaPluginIdOf, type QuotaConclusion } from "../quota-state.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { listAggregateModels } from "../aggregate.ts";
import {
  allPlatforms,
  forgetPlatformPolicy,
  isPlatform,
  platformOfAny,
  platformPolicies,
  setPlatformPolicy as writePlatformPolicy,
  type Platform,
} from "../platforms.ts";
import { kindOf, selectableKinds } from "../provider-kinds.ts";
import { policyEnum, policyErrorText, policyFromEnum } from "./policy.ts";
import { usageEvents, usageSummary, type UsageTotals } from "./usage.ts";
import { tailLog } from "./log.ts";
import { benefitUpstreams, benefits } from "./benefits.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 服务的版本号。 */
function serviceVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}

/** 一个用量的合计。 */
function usageSummaryMessage(summary: UsageTotals) {
  return create(UsageSummarySchema, {
    requests: BigInt(summary.requests),
    succeeded: BigInt(summary.succeeded),
    failed: BigInt(summary.failed),
    promptTokens: BigInt(summary.promptTokens),
    completionTokens: BigInt(summary.completionTokens),
    reasoningTokens: BigInt(summary.reasoningTokens),
    latencyMsSum: BigInt(summary.latencyMsSum),
  });
}

/** 一组用量。 */
function usageBucketMessage(bucket: { key: string; summary: UsageTotals }) {
  return create(UsageBucketSchema, {
    key: bucket.key,
    summary: usageSummaryMessage(bucket.summary),
  });
}

/**
 * 0–100 的整数百分比。
 *
 * proto 里这两个百分比字段是 int32：上游给的是算出来的小数（端砚报
 * 95.458552），不取整的话 JSON 里就带着小数，客户端解码时抛「expected
 * number (int32)」，整个面板整页报错（2026-10-28 真出过）。
 */
function percentInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 整毫秒。
 *
 * proto 的时间戳是 int64：BigInt(浮点) 会直接抛 RangeError。
 */
function wholeMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 面板送来的可选一格：没给与给了空串是两件事。
 *
 * 契约里带 presence 的格没给时是 undefined，往下那一层拿 undefined 当「别动」、
 * 拿空串当「清空」。收成 String(value ?? "") 会把两件事糊成一件，只改一部分
 * 字段的调用方就把没送的格清掉了。
 */
function givenText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value;
}

/**
 * 面板送来的可选开关：没给与给了 false 是两件事。
 *
 * 契约里带 presence 的 bool 没给时是 undefined。只改别的字段的调用方不能把一个
 * 打开着的开关顺手关掉，所以这一格保持 undefined 往下传（那一层拿 undefined 当
 * 「别动」）。
 */
function givenBool(value: boolean | undefined): boolean | undefined {
  return value === undefined ? undefined : value;
}

/**
 * 一个额度摘要。
 *
 * 三格结论（状态、恢复时刻、一句话）与数字一起走：面板靠它们回答「为什么这里
 * 没有数字」。没有结论就是空串 / 0 / 空串。
 */
export function quotaMessage(quota: QuotaView, conclusion?: QuotaConclusion | null) {
  return create(UpstreamQuotaSchema, {
    upstreamId: quota.upstreamId,
    accountId: quota.accountId,
    // 账号的名字：面板拿它当卡片标题，空串时退回显示 id。
    accountName: quota.accountName ?? "",
    // 余额（钱）。只有中转站这类平台有。
    balance: quota.balance
      ? create(BalanceSummarySchema, {
          availableCny: quota.balance.availableCny,
          currency: quota.balance.currency,
          lots: quota.balance.lots.map((lot) =>
            create(BalanceLotSchema, {
              id: lot.id,
              sourceLabel: lot.sourceLabel,
              remainingCny: lot.remainingCny,
              // int64 的时间戳：上游给的是浮点毫秒，BigInt 会抛。
              expiresAt: BigInt(wholeMs(lot.expiresAt)),
              status: lot.status,
            }),
          ),
          nextExpiryAt: BigInt(wholeMs(quota.balance.nextExpiryAt)),
          expiringCny: quota.balance.expiringCny,
        })
      : undefined,
    // 积分（点数）。跟余额不是一回事。
    credits: quota.credits
      ? create(CreditSummarySchema, {
          total: quota.credits.total,
          used: quota.credits.used,
          remaining: quota.credits.remaining,
          lots: quota.credits.lots.map((lot) =>
            create(CreditLotSchema, {
              id: lot.id,
              sourceLabel: lot.sourceLabel,
              remaining: lot.remaining,
              expiresAt: BigInt(wholeMs(lot.expiresAt)),
              status: lot.status,
            }),
          ),
          note: quota.credits.note,
        })
      : undefined,
    // 套餐额度：只有 MiniMax 有别的上游不带这个。
    tokenPlan: quota.tokenPlan
      ? create(TokenPlanSchema, {
          windows: quota.tokenPlan.windows.map((window) =>
            create(TokenPlanWindowSchema, {
              label: window.label,
              // proto 的这两个字段是 int32：百分比是算出来的小数，不取整会让
              // 整个面板解码失败（2026-10-28 真出过）。
              intervalPercent: percentInt(window.intervalPercent),
              weeklyPercent: percentInt(window.weeklyPercent),
              intervalEndsAt: BigInt(wholeMs(window.intervalEndsAt)),
              weeklyEndsAt: BigInt(wholeMs(window.weeklyEndsAt)),
            }),
          ),
        })
      : undefined,
    // 这一次问额度的结论：状态原样透出，恢复时刻不知道就是 0，一句话没有就是
    // 空串。认不出的状态与「没有结论」都落到空串 —— 契约说空串是「没有结论」。
    quotaState: conclusion?.state ?? "",
    // 这个数与路由 402/503 那句是同一个：都由 accountRecoveryAtMs 算
    // （lib/admin/platform-state.ts），这里不再自己取一份。
    recoverAtMs: BigInt(wholeMs(conclusion?.recoverAtMs ?? 0)),
    message: conclusion?.message ?? "",
  });
}

/**
 * 现在的额度快照。
 *
 * 只读：面板这一次拿快照里那一份，问问上游是后台扫描的事（lib/admin/upstreams.ts）。
 */
function quotaSnapshot(): HealthSnapshot | null {
  return peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
}

/** 一个账号这一次的额度结论；账号行不在就是没有结论。 */
function conclusionOfRow(row: ProviderRow | null | undefined): QuotaConclusion | null {
  if (!row) return null;
  const conclusion = quotaConclusionOf(row, quotaSnapshot(), quotaPluginIdOf(row));
  return conclusion.state ? conclusion : null;
}

/**
 * 额度那一格报什么。
 *
 * 只要有结论就报：状态、恢复时刻、一句话三格回答「为什么这里没有数字」。见底、
 * 账号不能用、凭据被拒、被限流、没填凭据、问不到 —— 六种都是结论，面板按状态
 * 说话。只放行前两种的话，后四种在面板上一律是一个「—」，前端按七种状态写的那
 * 一半是死代码。
 *
 * 没有结论（没指名插件、插件没登记、快照里没这一份）才不报这一格：那不是「问
 * 过了没数字」，是没人去问。
 */
function quotaAnswerOf(quota: QuotaView | null, row: ProviderRow | null): UpstreamQuota | undefined {
  const conclusion = conclusionOfRow(row);
  if (quota) return quotaMessage(quota, conclusion);
  if (!row || !conclusion) return undefined;
  // 没有数字的那一份只要归属与结论：upstreamId 是平台（面板按它分组），
  // accountId 是这个账号。
  return quotaMessage({ upstreamId: row.platform, accountId: row.id, accountName: row.alias ?? "" }, conclusion);
}

/**
 * 平台这一行按住哪个账号的结论。
 *
 * 有数字时就是那份额度所属的账号；没有数字时报名下第一个有结论的那个 ——
 * 面板要能说清这个平台为什么没有数字。
 */
function quotaRowOfPlatform(rows: ProviderRow[], quota: QuotaView | null): ProviderRow | null {
  if (quota) return rows.find((row) => row.id === quota.accountId) ?? null;
  return rows.find((row) => conclusionOfRow(row) !== null) ?? null;
}

/**
 * 这一次 GetBalance 要报哪些账号。
 *
 * 指定了上游就只报它名下的：平台 id 报全部账号，账号 id 就报那一个。
 */
function balanceScope(wanted: string): ProviderRow[] {
  if (!wanted) return listProviders();
  if (isPlatform(wanted)) return accountsOfPlatform(wanted);
  const row = provider(wanted);
  return row ? [row] : [];
}

/**
 * 一个平台在面板上的样子。
 *
 * 平台有两处数据源：代码里的模板与表里的开放平台，所以这一条可能来自任意
 * 一处；它名下的账号是数据，有几个算几个 —— 一个没有就是空的账号列表。
 *
 * 平台的样子（名字、kind）由调用方给：它一次问齐了所有平台的样子，免得每个
 * 平台再查一遍库。判定也是一次算齐的：面板与路由看的必须是同一个答案
 * （lib/admin/platform-state.ts）。
 *
 * `fromRow` 是「表里有没有属于它的那一行」：有行的平台面板才能改与删。它与
 * `isOpenPlatform` 不是同一件事 —— 模拟客户端那一族有行，但地址与目录归代码，
 * 那几格在这一条上仍然是空的。
 */
function platformMessage(
  id: string,
  platform: Platform | null,
  availability: PlatformAvailability | null,
  accounts: Map<string, AccountView>,
  open: OpenPlatformRow | null,
  row: OpenPlatformRow | null,
) {
  // 表里有没有属于它的那一行：有行的平台面板才能改与删。不跟着 open 走 ——
  // 模拟客户端那一族有行，但它们不是开放平台。
  const fromRow = row !== null;
  const credential = availability ? upstreamCredentialOf(availability) : upstreamCredential(id);
  // 名下的账号行：判定那一份已经读过表了，没判定就现读。额度与账号两处都要它。
  const rows = availability ? availability.rows : accountsOfPlatform(id);
  const quota = upstreamQuota(id);
  // 冷却：路由绕开这个账号到什么时候，面板要看得见。
  const cooling = upstreamCooling(id);
  // 面板上该做什么：冷却与额度那一层的话更细（几点的窗口、为什么冷却、几个
  // 账号里的几个），别的（没有账号、账号都关着、没有凭据）只有判定说得清。
  const stateReason = availability ? cooling.stateReason || availability.advice : cooling.stateReason;
  const enabled = availability ? availability.on > 0 : rows.some((row) => row.enabled);
  return create(UpstreamSchema, {
    id,
    // 平台的名字是模板里的那个（“Qoder（全球区）”）—— 账号的别名不能顶在这里：
    // 一个平台下有几个账号时，用哪个的别名都是错的。
    label: platform?.label ?? id,
    kind: platform?.kind ?? "",
    // 现在在生效的值：名下有没有开着的账号。平台自己没有开关，开关在账号上。
    enabled,
    // 名下的多个账号怎么选。策略在平台层。
    policy: upstreamPolicy(id),
    // 这个平台支持哪几个策略：面板只给它支持的那几个。
    policies: platformPolicies(id).map(policyEnum),
    // 名下有几个账号。面板用它判「策略有没有用」。
    accountCount: availability ? availability.accounts : upstreamAccountCount(id),
    // 名下有没有开着的账号 —— 跟 enabled 同一个答案，两个名字一个是给机器判
    // 断用的、一个是给面板画开关用的，别让它们各说各话。
    hasEnabledAccount: enabled,
    // 现在能不能接：额度用尽、正在登录这些面板自己拼不出来的事，后端知道。
    state: availability ? upstreamStateOf(availability) : upstreamState(id),
    modelCount: upstreamModelCount(id),
    // 凭据在账号上：这里报的是名下最好的那一份，要逐个看就在 accounts 里。
    credential: create(CredentialStatusSchema, {
      kind: credential.kind,
      status: credential.status,
      fingerprint: credential.fingerprint,
      expiresAt: BigInt(credential.expiresAt),
      remainingSec: BigInt(credential.remainingSec),
      warning: credential.warning,
      detail: credential.detail,
      generation: credential.generation,
    }),
    quota: quotaAnswerOf(quota, quotaRowOfPlatform(rows, quota)),
    // 地址：开放平台的在平台行里，模板平台的从名下一个账号的 kind 算。
    //
    // 开放平台必须报平台行里那份：平台刚建好还没加账号时，名下没有账号，
    // 从账号那一头算地址只能算出一个空串 —— 面板上编辑这样一个平台时地址框
    // 是空的，整单提交带空串，写入侧就以「得有个地址」把这一单挡掉，于是
    // 加账号之前什么都存不进去。
    baseUrl: open ? open.baseUrl : upstreamBaseUrl(id),
    region: upstreamRegion(id),
    // 额度插件与模型目录：只有开放平台有这几格（模板平台是空串与空目录）。
    quotaPlugin: open?.quotaPlugin ?? "",
    // 共性表那个开关（面板上的一个勾）：模拟客户端那一族的行也有，所以照表里的
    // 那一行报，不跟着 open（open 把那一族滤掉了）。
    traitsFromCommon: row?.traitsFromCommon ?? false,
    // 模型目录两格：目录本身与上次拉的时刻。模板平台没有这一份目录，所以是
    // 空与 0（0 的意思是「没拉过」，不是「没有模型」）。
    models: open?.models.items ?? [],
    modelsFetchedAtMs: BigInt(open?.models.fetchedAt ?? 0),
    // 人给这些模型写的元数据：模板平台也有（目录是代码的，人写的那一层同样是
    // 人写的那一层），所以不跟着 open 走。
    modelOverrides: listModelOverrides(id).map(modelOverrideMessage),
    // 这是不是一个开放平台：表里的那一行，不是代码里的模板。
    isOpenPlatform: open !== null,
    // 表里有没有属于它的那一行：有行的平台面板才能改与删。模拟客户端那一族
    // 有行（isOpenPlatform 是 false，地址与目录归代码），所以它与上面那格
    // 分开报 —— 面板拿 isOpenPlatform 当判据时，入口就少了一整族。
    fromRow,
    // 冷却：名下最早到期的那个账号、最早能再接的时刻、一句话。
    cooldownUntilMs: BigInt(cooling.cooldownUntilMs),
    cooldownReason: cooling.cooldownReason,
    // 最早能再接的时刻：面板自己的那个（0 = 算不出来，不猜）。
    //
    // 判定那边也有一个时刻（untilMs），但那是路由用的「最早能试的时刻」：算不
    // 出来时它会给一个固定时长，而面板的契约说 0 是「算不出来」。两处的口径
    // 不一样，记在交付记录里。
    recoversAtMs: BigInt(cooling.recoversAtMs),
    stateReason,
    accounts: (availability ? availability.rows : rows).flatMap((row) => {
      // 账号视图是外面算好的那一份：这里再读一遍凭据的话，一个平台下的每个
      // 账号都要把全部账号的凭据读一遍（面板打开一次就是 O(N²)）。
      const account = accounts.get(row.id);
      return account ? [accountRowMessage(account)] : [];
    }),
  });
}

/* ---------------- 登录授权的形状 ---------------- */

/** 一次登录会话，面板看的形状。 */
function loginSessionMessage(session: StoredLogin) {
  return create(LoginSessionSchema, {
    loginId: session.loginId,
    upstreamId: session.upstreamId,
    accountId: session.accountId,
    status: session.status,
    method: session.method,
    authorizationUrl: session.authorizationUrl,
    userCode: session.userCode,
    expiresAt: BigInt(session.expiresAt),
    message: session.message,
    credential: session.credentialId ? credentialStatusMessage(session.credentialId) : undefined,
    username: session.username,
  });
}

/** 一条凭据的状态摘要。 */
function credentialStatusMessage(credentialId: string) {
  const row = listCredentials().find((c) => c.id === credentialId);
  if (!row) return undefined;
  return create(CredentialStatusSchema, {
    kind: row.kind,
    status: row.status,
    fingerprint: row.fingerprint,
    expiresAt: BigInt(row.expiresAt),
    remainingSec: BigInt(Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000))),
    warning: row.expiresAt > 0 && row.expiresAt - Date.now() < 7 * 24 * 3600 * 1000,
    detail: row.label,
    generation: row.generation,
  });
}

/** 一个账号，面板看的形状。 */
function accountMessage(accountId: string) {
  if (!accountId) return undefined;
  const row = listAccounts().find((a) => a.id === accountId);
  return row ? accountRowMessage(row) : undefined;
}

/**
 * 一个账号行，面板看的形状。
 *
 * 账号视图（凭据、状态）由调用方算好传进来：账号行自己再去读一遍凭据的话，
 * 一个平台下的每个账号都要把全部账号的凭据重读一遍 —— 面板打开一次就是
 * O(N²) 次读库。
 */
function accountRowMessage(row: AccountView) {
  // 额度是**这个账号自己的**：平台行上那个是名下账号合起来的，账号行上要
  // 看得见自己那份（两个 MiniMax 账号各有各的套餐）。
  const quota = upstreamQuota(row.id);
  // 冷却也是这个账号自己的：面板要能看出是哪一个账号被绕开了。
  const cooling = coolingOf(row.id);
  return create(AccountSchema, {
    id: row.id,
    // 它属于哪个平台。路径里用平台 id，不用账号 id。
    platform: row.platform,
    alias: row.alias,
    status: credentialStateText(row.status),
    credentialCount: row.credentialCount,
    detail: row.detail,
    enabled: row.enabled,
    // 权重：大的先试。面板上让人调。
    weight: row.weight,
    createdAt: BigInt(row.createdAt),
    quota: quotaAnswerOf(quota, provider(row.id)),
    cooldownUntilMs: BigInt(cooling.untilMs),
    cooldownReason: cooling.reason,
  });
}

/** 一条凭据，面板看的形状。 */
function credentialMessage(credentialId: string) {
  if (!credentialId) return undefined;
  const row = listCredentials().find((c) => c.id === credentialId);
  if (!row) return undefined;
  return create(CredentialSchema, {
    id: row.id,
    accountId: row.accountId,
    upstreamId: row.platform,
    kind: row.kind,
    label: row.label,
    masked: row.masked,
    fingerprint: row.fingerprint,
    status: credentialStateText(row.status),
    generation: row.generation,
    expiresAt: BigInt(row.expiresAt),
    lastOkAt: BigInt(row.lastOkAt),
    lastError: row.lastError,
    updatedAt: BigInt(row.updatedAt),
  });
}

/** 登录的错误怎么变成面板上的话。 */
function loginErrorText(e: unknown): string {
  const err = e as { hint?: string; message?: string };
  const hint = err?.hint ?? "";
  const code = err?.message ?? "";
  if (hint && code && !hint.includes(code)) return `${hint}（${code}）`;
  return hint || code || "登录未成功。";
}

/**
 * 平台：模板与表里的开放平台，面板看的那一层。
 *
 * 两处数据源都在列：代码里的模板与表里的开放平台（allPlatforms）。开放平台的
 * kind 已经接进注册表（lib/kinds/openai.ts），列出来不是一行接不了请求的东西。
 */
function platformMessages() {
  // 平台的样子一次问齐（platformOfAny），别每个平台再查一遍库。
  const platforms = allPlatforms();
  const known = new Map(platforms.map((p) => [p.id, platformOfAny(p.id)]));
  // 判定也一次算齐：面板与路由看的必须是同一个答案。
  const availabilities = platformAvailabilities(platforms);
  // 账号视图也一次算齐：每个账号行自己去读凭据的话，平台一多就是 O(N²)。
  const accounts = new Map(listAccounts().map((a) => [a.id, a]));
  // 平台行：那几格（额度插件、自动拉、目录）只有开放平台有。模拟客户端那一族
  // 的行长得一样，但它们不是开放平台 —— 判别按 kind，不按「在不在代码模板里」
  // （模板名单已经空了）。
  //
  // 全部行另存一份：openRows 已经把模拟客户端滤掉了，而「有没有行」与共性表
  // 那个开关问的是表里的那一行，不分族。两件事一张 map 说不完。
  const allRows = listOpenPlatforms();
  const rowById = new Map(allRows.map((row) => [row.id, row]));
  const openRows = new Map(
    allRows.filter((row) => !isSimulatedClientKind(row.kind)).map((row) => [row.id, row]),
  );
  return platforms.flatMap((platform) => {
    const message = platformMessage(
      platform.id,
      known.get(platform.id) ?? null,
      availabilities.get(platform.id) ?? null,
      accounts,
      openRows.get(platform.id) ?? null,
      rowById.get(platform.id) ?? null,
    );
    return message ? [message] : [];
  });
}

/**
 * 一个开放平台，面板看的形状。
 *
 * 只报表里那一行：模板平台不是开放平台，它们没有这一行可报。
 */
function openPlatformMessage(row: OpenPlatformRow) {
  return create(OpenPlatformSchema, {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    quotaPlugin: row.quotaPlugin,
    models: row.models.items,
    modelsFetchedAtMs: BigInt(row.models.fetchedAt),
    // 建的时候定下的那一类：面板靠它决定这一排平台能用哪些凭据格子、要不要
    // 显示「刷新模型目录」。
    kind: row.kind,
  });
}

/** 一个模型的人工元数据，面板看的形状。 */
function modelOverrideMessage(row: ModelOverrideRow) {
  return create(ModelOverrideSchema, {
    id: row.id,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    toolCall: row.toolCall,
    // 这一格有 presence：写了空列表 = 不能选档，这时也要回一个空的 EffortList；
    // 没写就不给这一格 —— 反过来读（空 = 没写）的话，面板把读到的原样存回来
    // 会把代码表里的档位抹掉。
    effortOptions:
      row.effortOptions === undefined ? undefined : create(EffortListSchema, { levels: [...row.effortOptions] }),
    credits: row.credits,
  });
}

/**
 * 面板发过来的那一条，按「写了的字段」读。
 *
 * `effortOptions` 裹在 EffortList 里就是为了 presence：没给 = 没写（沿用原来的
 * 档位），给了空列表 = 明确不能选档。
 */
function modelOverrideRow(message: ModelOverride): ModelOverrideRow {
  // 读不懂的档位当作没写（跟 readRow 里「类型不对的字段当作没写」同一条）：从解码
  // 过的请求过来时，这一格一定是个 EffortList。
  const levels = Array.isArray(message.effortOptions?.levels) ? message.effortOptions.levels : undefined;
  return {
    id: String(message.id ?? ""),
    ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
    ...(message.contextWindow !== undefined ? { contextWindow: message.contextWindow } : {}),
    ...(message.maxOutputTokens !== undefined ? { maxOutputTokens: message.maxOutputTokens } : {}),
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(message.toolCall !== undefined ? { toolCall: message.toolCall } : {}),
    ...(levels === undefined ? {} : { effortOptions: [...levels] }),
    ...(message.credits !== undefined ? { credits: message.credits } : {}),
  };
}

/**
 * 上游报的计费 → 契约那一头的形状。
 *
 * 分时段倍率只送 factor：`when` 是个嵌套的时段表达式，面板这一格用不上，抄过去
 * 只会多一份没人读的解析。
 */
function modelBillingMessage(billing: ModelBilling) {
  return create(ModelBillingSchema, {
    mode: billing.mode,
    // 没有币种就空串：契约里这一格是 string（没 presence），空串是「不知道」。
    currency: billing.currency ?? "",
    ...(billing.inputPerMillion === undefined ? {} : { inputPerMillion: billing.inputPerMillion }),
    ...(billing.outputPerMillion === undefined ? {} : { outputPerMillion: billing.outputPerMillion }),
    ...(billing.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadPerMillion: billing.cacheReadPerMillion }),
    ...(billing.credits === undefined ? {} : { credits: billing.credits }),
    multipliers: (billing.multipliers ?? []).map((multiplier) => multiplier.factor),
    // 上游报了但不是价格（全 0 又没说币种与单位）：这是结论，不是空。
    unknown: billing.unknown === true,
  });
}

/** 管理接口的实现。 */
export const adminService: Partial<ServiceImpl<typeof AdminService>> = {
  /* ---------------- 系统 ---------------- */

  async getSystemStatus() {
    // 先看一眼快照：旧了就起一个后台刷新，面板这次拿旧答案、下次拿新的。
    healthSnapshot();
    return create(GetSystemStatusResponseSchema, {
      version: serviceVersion(),
      upstreams: platformMessages(),
      pendingRestart: pendingRestart(),
      uptimeSec: BigInt(Math.round(process.uptime())),
      publishedModelCount: publishedModels().filter((m) => m.published).length,
      adminTokenSet: adminTokenSet(),
    });
  },

  async restartSystem() {
    // 容器是 restart: unless-stopped 起的，进程退出去它就会把新配置带起来。
    // 先把答复送出去，再退。
    setTimeout(() => {
      console.log("[ADMIN] 面板要求重启：进程退出，容器会把它拉起来");
      process.exit(0);
    }, 500);
    return create(RestartSystemResponseSchema, {
      accepted: true,
      message: "进程正在退出，容器会自动重启。前端稍后重连。",
    });
  },

  /* ---------------- 平台与账号 ---------------- */

  async listUpstreams() {
    // 列表是平台的数据源（代码里的模板 + 表里的开放平台），不是账号的：
    // 一个平台下没有账号也照样列出来，面板要在它下面「新增账号」。
    return create(ListUpstreamsResponseSchema, { upstreams: platformMessages() });
  },

  async listProviderKinds() {
    return create(ListProviderKindsResponseSchema, {
      kinds: selectableKinds().map((k) =>
        create(ProviderKindSchema, {
          kind: k.kind,
          label: k.label,
          login: k.login,
          needsRegion: k.needsRegion,
          regions: k.regions,
          // 这一类上游支持哪几个策略：面板的选项从这里来。
          // 兜底在 platformPolicies 里（没登记的种类只给「单一」）。
          policies: k.policies.map(policyEnum),
          // 填凭据那几格也由种类说：面板不自己留一张按 kind 查的表
          // （那样一份知识就有两处会走样）。
          credentialTitle: k.credentialTitle,
          credentialFields: k.credentialFields.map((f) =>
            create(CredentialFieldSchema, {
              name: f.name,
              label: f.label,
              hint: f.hint ?? "",
              placeholder: f.placeholder ?? "",
            }),
          ),
        }),
      ),
    });
  },

  async addAccount(request) {
    const result = addAccount({
      platform: String(request.platform ?? ""),
      alias: String(request.alias ?? ""),
    });
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] 在 ${request.platform} 下加了账号 ${result.id}`);
    return create(AddAccountResponseSchema, { id: result.id ?? "" });
  },

  async updateProvider(request) {
    // 别名与开关。策略不在这里：契约里的 alias 是普通 proto3 string，没有
    // presence 位，混在一起的话「只改策略」会把别名顺手抹掉。
    const patch: { alias?: string; enabled?: boolean; weight?: number } = {};
    if (request.alias !== undefined) patch.alias = String(request.alias);
    if (request.enabled !== undefined && request.enabled !== null) patch.enabled = request.enabled === true;
    if (request.weight !== undefined && request.weight !== null) patch.weight = Number(request.weight);
    const result = updateProvider(String(request.id ?? ""), patch);
    if (result.ok) console.log(`[ADMIN] 账号 ${request.id} 改了`);
    return create(UpdateProviderResponseSchema, { ok: result.ok, message: result.message });
  },

  async setPlatformPolicy(request) {
    const platform = String(request.platform ?? "");
    // 契约里的枚举 → 库里存的策略。不认识的（UNSPECIFIED 或别的数字）就是
    // 「给错了」，不写库。
    const policy = policyFromEnum(Number(request.policy));
    if (!policy) {
      return create(SetPlatformPolicyResponseSchema, {
        ok: false,
        message: policyErrorText(request.policy),
      });
    }
    // 平台支不支持这个策略：只有一个账号的平台选了也没用，所以那边只给「单一」。
    // 校验在 lib/platforms.ts 里，这里只把结果转成一句面板能看的话。
    const result = writePlatformPolicy(platform, policy);
    if (result.ok) console.log(`[ADMIN] 平台 ${platform} 的策略改成 ${policy}`);
    return create(SetPlatformPolicyResponseSchema, { ok: result.ok, message: result.message });
  },

  async deleteAccount(request) {
    const id = String(request.id ?? "");
    const result = deleteAccount(id);
    if (result.ok) {
      console.log(`[ADMIN] 删了账号 ${id}（连它的凭据一起）`);
    }
    return create(DeleteAccountResponseSchema, { ok: result.ok, message: result.message });
  },

  async setAccountEnabled(request) {
    const id = String(request.accountId ?? "") as UpstreamId;
    const result = setAccountEnabled(id, request.enabled === true);
    console.log(`[ADMIN] 账号 ${id} 改成 ${request.enabled ? "true" : "false"}（立刻生效）`);
    return create(SetAccountEnabledResponseSchema, {
      ok: result.ok,
      pendingRestart: pendingRestart(),
      message: result.message,
    });
  },

  /* ---------------- 开放平台 ---------------- */

  async addPlatform(request) {
    const id = String(request.id ?? "");
    // 校验与归一都在那一层（id 的规矩、地址的归一、模板与账号的重名，还有
    // kind 在不在能建的那张表里）。失败带机器码，细节只说事实。
    const result = createOpenPlatform({
      id,
      label: String(request.label ?? ""),
      baseUrl: String(request.baseUrl ?? ""),
      kind: String(request.kind ?? ""),
      // 这一格带 presence：没给（undefined）= 用这一类声明的默认插件；给了空串
      // = 不用插件。别用 ?? "" 抹平 —— 抹平了「没给」就变成了「不用插件」。
      quotaPlugin: request.quotaPlugin,
    });
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] 加了开放平台 ${id}`);
    const row = openPlatformOf(id.trim());
    return create(AddPlatformResponseSchema, { platform: row ? openPlatformMessage(row) : undefined });
  },

  async updatePlatform(request) {
    const id = String(request.id ?? "").trim();
    // base_url 与 quota_plugin 带 presence：没给 = 别动那一格，给了空串 = 清空。
    // 名字也照这条走（没给 = 别动；显式空串 = 错，平台得有名字），不这么写的话
    // “只改额度插件”那一单会先撞在“得有个名字”上。
    // 目录不在这里改：目录归上游（方言族）还是归代码（模拟客户端）由平台的族
    // 决定，不是面板说了算。面板要换目录，去点「刷新模型目录」。
    const patch: {
      label?: string;
      baseUrl?: string;
      quotaPlugin?: string;
      traitsFromCommon?: boolean;
    } = {
      label: givenText(request.label),
      baseUrl: givenText(request.baseUrl),
      // 没给 = 别动这一格；空串 = 不选插件。
      quotaPlugin: givenText(request.quotaPlugin),
      // 带 presence 的开关：没给 = 别动（只改名字的单子不能把它清零）。
      traitsFromCommon: givenBool(request.traitsFromCommon),
    };
    const result = updateOpenPlatform(id, patch);
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] 开放平台 ${id} 改了`);
    const row = openPlatformOf(id.trim());
    return create(UpdatePlatformResponseSchema, {
      platform: row ? openPlatformMessage(row) : undefined,
    });
  },

  async deletePlatform(request) {
    const id = String(request.id ?? "").trim();
    const row = openPlatformOf(id);
    if (!row) throw adminError("PLATFORM_NOT_FOUND", `no platform ${id}`);
    // 名下的账号：连凭据、冷却、健康快照里它的那一段一起删（走删账号那条路，
    // 它知道每个平台的凭据放在哪）。
    const accounts = accountsOfPlatform(id);
    for (const account of accounts) deleteAccount(account.id);
    // 指向这个平台的已发布模型：目标留着，面板上它显示「平台已停用」——
    // 这与平台停用、账号被删时的做法一样（lib/admin/models.ts 的 targetBlocker：
    // 不认识的分组当作关着）。删掉目标就是发明新规则了。
    const affected = listAggregateModels().filter((model) =>
      model.targets.some((target) => target.group === id),
    );
    const deleted = deleteOpenPlatform(id);
    if (!deleted.ok) throw adminError(deleted.code, deleted.message);
    // 平台自己的策略也清掉：平台没了，那一行就是一根没人认的指针（下次用
    // 同一个 id 建回来，它会凭空继承旧策略）。
    forgetPlatformPolicy(id);
    // 连带删掉的东西写进日志：答复里没有 message 了，出过什么事就只剩这一处。
    console.log(
      `[ADMIN] 删了开放平台 ${id}（${row.label}）：连 ${accounts.length} 个账号一起，` +
        `${affected.length} 个已发布模型指向它（现在显示平台已停用）`,
    );
    return create(DeletePlatformResponseSchema, {});
  },

  async refreshPlatformModels(request) {
    const id = String(request.platformId ?? "").trim();
    // 拉不到不是错误：原来那份目录留着（答复里说的就是现在这份）。
    //
    // force：这是人手动点的刷新，要穿透失败退避（退避只该拦后台与请求路径上
    // 那些没人看着的调用）。
    const outcome = await refreshOpenPlatformCatalog(id, { force: true }).catch((e) => ({
      ok: false,
      message: `无法获取模型目录：${(e as Error)?.message ?? String(e)}`,
    }));
    const row = openPlatformOf(id);
    return create(RefreshPlatformModelsResponseSchema, {
      ok: outcome.ok,
      message: outcome.message,
      models: row?.models.items ?? [],
    });
  },

  async listQuotaPlugins() {
    return create(ListQuotaPluginsResponseSchema, {
      plugins: allQuotaPlugins().map((plugin) =>
        create(QuotaPluginSchema, {
          id: plugin.id,
          label: plugin.label,
          fields: plugin.fields.map((field) =>
            create(QuotaPluginFieldSchema, {
              name: field.name,
              label: field.label,
              secret: field.secret,
            }),
          ),
        }),
      ),
    });
  },

  async listPlatformKinds() {
    // 两族：先是「用户自己加的一类」（方言与厂商 kind，选的是这一类怎么跟上游
    // 说话），再是预置的模拟客户端（从目录里挑一个）。顺序照表里的顺序：面板按
    // 答复渲染下拉，不自己排。
    //
    // 默认地址取自 kind 注册表（ProviderKind.defaultBaseUrl）：catalog 那一列是
    // 空的，地址是各自适配器的地址常量，不写在面板这一层。额度插件同理（注册表
    // 里的 defaultQuotaPlugin）：面板建平台时拿它预填那一格，用户可以改。
    return create(ListPlatformKindsResponseSchema, {
      kinds: platformKindChoices().map((option) =>
        create(PlatformKindSchema, {
          kind: option.kind,
          label: option.label,
          defaultBaseUrl: kindOf(option.kind)?.defaultBaseUrl ?? "",
          defaultQuotaPlugin: kindOf(option.kind)?.defaultQuotaPlugin ?? "",
          category: option.category,
          presetId: option.presetId,
          region: option.region,
        }),
      ),
    });
  },

  /* ---------------- 模型的人工元数据 ---------------- */

  async listModelOverrides(request) {
    // 平台不存在就是空列表，不报错：面板刚删完一个平台时还会问一下。
    return create(ListModelOverridesResponseSchema, {
      overrides: listModelOverrides(String(request.platformId ?? "")).map(modelOverrideMessage),
    });
  },

  async setModelOverrides(request) {
    // 走契约解码时这一格一定是列表；别处（脚本、手写的请求）不一定 —— 不是列表
    // 就说到这里，别让 `.map` 的 TypeError 冒成 500。
    const sent: unknown = request.overrides;
    if (!Array.isArray(sent)) {
      throw adminError("MODEL_OVERRIDE_LIST_INVALID", `overrides is ${typeof sent}, not an array`);
    }
    // 发来的每一条按 id 覆盖，没发来的原封不动：删走 DeleteModelOverride。
    const result = upsertModelOverrides(
      String(request.platformId ?? ""),
      sent.map((one) => modelOverrideRow(one as ModelOverride)),
    );
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] ${request.platformId} 的人工模型元数据：${result.message}`);
    return create(SetModelOverridesResponseSchema, {});
  },

  async deleteModelOverride(request) {
    const result = deleteModelOverride(
      String(request.platformId ?? ""),
      String(request.modelId ?? ""),
    );
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] ${request.platformId} 的人工模型元数据：${result.message}`);
    return create(DeleteModelOverrideResponseSchema, {});
  },

  /* ---------------- 配置 ---------------- */

  async listConfig() {
    return create(ListConfigResponseSchema, {
      items: configItems().map((item) =>
        create(ConfigItemSchema, {
          key: item.key,
          // 给人看的名字：「Qoder 中国区」。不是 env 的键名。
          label: item.label,
          value: item.value,
          source: item.source,
          fallback: item.fallback,
          group: item.group,
          description: item.description,
          secret: item.secret,
          hasValue: item.hasValue,
        }),
      ),
      pendingRestart: pendingRestart(),
    });
  },

  async setConfig(request) {
    const key = String(request.key ?? "").trim();
    if (!key) {
      return create(SetConfigResponseSchema, { ok: false, pendingRestart: pendingRestart(), message: "需要提供键名" });
    }
    if (!knownConfigKeys().has(key)) {
      return create(SetConfigResponseSchema, {
        ok: false,
        pendingRestart: pendingRestart(),
        message: `无法识别的配置项：${key}`,
      });
    }
    const result = setConfigValue(key, String(request.value ?? ""), request.clear === true);
    console.log(`[ADMIN] 配置 ${key}：${result.message}`);
    return create(SetConfigResponseSchema, {
      ok: result.ok,
      pendingRestart: pendingRestart(),
      message: result.ok ? `${result.message}，已生效` : result.message,
    });
  },

  /* ---------------- 账号与凭据 ---------------- */

  async listAccounts() {
    const accounts = listAccounts();
    // 每个账号的额度。额度在快照里，这里不现问上游（那是 GetBalance 的事）。
    const quotas = new Map<string, QuotaView>();
    // 额度结论要的是账号行（插件从平台那一行读），顺手把它们存下来。
    const rows = new Map<string, ProviderRow>();
    for (const row of listProviders()) {
      const id = row.id;
      rows.set(id, row);
      for (const quota of await upstreamQuotas(id)) {
        quotas.set(quota.accountId, quota);
      }
    }
    return create(ListAccountsResponseSchema, {
      accounts: accounts.map((account) => {
        const quota = quotas.get(account.id);
        return create(AccountSchema, {
          id: account.id,
          // 账号属于哪个平台。路径里用平台 id，不用账号 id。
          platform: account.platform,
          alias: account.alias,
          status: credentialStateText(account.status),
          credentialCount: account.credentialCount,
          detail: account.detail,
          enabled: account.enabled,
          createdAt: BigInt(account.createdAt),
          quota: quotaAnswerOf(quota ?? null, rows.get(account.id) ?? null),
        });
      }),
    });
  },

  async listCredentials(request) {
    const accountId = String(request.accountId ?? "");
    return create(ListCredentialsResponseSchema, {
      credentials: listCredentials(accountId).map((row) =>
        create(CredentialSchema, {
          id: row.id,
          accountId: row.accountId,
          upstreamId: row.platform,
          kind: row.kind,
          label: row.label,
          masked: row.masked,
          fingerprint: row.fingerprint,
          status: credentialStateText(row.status),
          generation: row.generation,
          expiresAt: BigInt(row.expiresAt),
          lastOkAt: BigInt(row.lastOkAt),
          lastError: row.lastError,
          updatedAt: BigInt(row.updatedAt),
        }),
      ),
    });
  },

  async testCredential(request) {
    const id = String(request.credentialId ?? "");
    const result = await testCredential(id);
    return create(TestCredentialResponseSchema, {
      ok: result.ok,
      message: result.message,
      checkedAt: BigInt(Date.now()),
    });
  },

  async logoutAccount(request) {
    const accountId = String(request.accountId ?? "");
    const result = logoutAccount(accountId);
    return create(LogoutAccountResponseSchema, {
      ok: result.ok,
      message: result.message,
      removed: result.removed,
    });
  },

  async setProviderKeys(request) {
    const upstreamId = String(request.upstreamId ?? "");
    // 位置有意义（七牛的凭据是两段：推理 key 与门户 cookie），空串留着占位。
    // 各分支自己决定怎么处理空串。
    const keys = (request.keys ?? []).map((k) => String(k).trim());
    const result = setProviderKeys(upstreamId, keys);
    if (!result.ok) throw adminError(result.code, result.message);
    console.log(`[ADMIN] 账号 ${upstreamId} 的凭据：${result.message}`);
    return create(SetProviderKeysResponseSchema, { count: result.count });
  },

  async refreshCredential(request) {
    const id = String(request.credentialId ?? "");
    const result = await refreshCredential(id);
    return create(RefreshCredentialResponseSchema, {
      ok: result.ok,
      message: result.message,
      generation: result.generation,
    });
  },

  /* ---------------- 额度 ---------------- */

  async getBalance(request) {
    const wanted = String(request.upstreamId ?? "");
    const rows = balanceScope(wanted);
    const quotas: UpstreamQuota[] = [];
    // 已经有数字的账号：下面只给没有数字的那些补一条原因。
    const withNumbers = new Set<string>();
    if (wanted) {
      // 问一个平台：只刷这个平台名下的账号，不碰别人。
      for (const quota of await upstreamQuotas(wanted, true, Boolean(request.force))) {
        const row = rows.find((r) => r.id === quota.accountId) ?? null;
        quotas.push(quotaMessage(quota, conclusionOfRow(row)));
        withNumbers.add(quota.accountId);
      }
    } else {
      // 没指定平台：整轮刷新一次（一次就够），然后从快照里读。
      await freshHealthSnapshot(Boolean(request.force));
      for (const row of rows) {
        for (const quota of await upstreamQuotas(row.id)) {
          quotas.push(quotaMessage(quota, conclusionOfRow(row)));
          withNumbers.add(quota.accountId);
        }
      }
    }
    // 没有数字但有结论的账号也报一条：见底、不能用、凭据被拒、被限流、没填
    // 凭据、问不到 —— 六种都不是 0，面板要看得见状态与那句话，而不是一行零。
    for (const row of rows) {
      if (withNumbers.has(row.id)) continue;
      const answer = quotaAnswerOf(null, row);
      if (answer) quotas.push(answer);
    }
    return create(GetBalanceResponseSchema, { quotas });
  },

  /* ---------------- 用量 ---------------- */

  async getUsageSummary(request) {
    const summary = usageSummary(String(request.upstreamId ?? ""), String(request.window ?? ""));
    return create(GetUsageSummaryResponseSchema, {
      total: usageSummaryMessage(summary.total),
      byUpstream: summary.byUpstream.map((bucket) => usageBucketMessage(bucket)),
      byModel: summary.byModel.map((bucket) => usageBucketMessage(bucket)),
      byDay: summary.byDay.map((bucket) => usageBucketMessage(bucket)),
      byAgent: summary.byAgent.map((bucket) => usageBucketMessage(bucket)),
      bySession: summary.bySession.map((bucket) => usageBucketMessage(bucket)),
      byParentSession: summary.byParentSession.map((bucket) => usageBucketMessage(bucket)),
      byAgentName: summary.byAgentName.map((bucket) => usageBucketMessage(bucket)),
      bySubagent: summary.bySubagent.map((bucket) => usageBucketMessage(bucket)),
    });
  },

  async listUsageEvents(request) {
    const events = usageEvents(
      String(request.upstreamId ?? ""),
      String(request.model ?? ""),
      Number(request.limit ?? 0),
      Number(request.beforeId ?? 0),
      String(request.window ?? ""),
    );
    return create(ListUsageEventsResponseSchema, {
      events: events.map((event) =>
        create(UsageEventSchema, {
          id: BigInt(event.id),
          ts: BigInt(event.ts),
          upstreamId: event.upstreamId,
          model: event.upstreamModel,
          agentModel: event.agentModel,
          agent: event.agent,
          sessionId: event.sessionId,
          parentSessionId: event.parentSessionId,
          agentName: event.agentName,
          client: event.client,
          promptTokens: BigInt(event.promptTokens),
          completionTokens: BigInt(event.completionTokens),
          reasoningTokens: BigInt(event.reasoningTokens),
          latencyMs: BigInt(event.latencyMs),
          // The status is the HTTP code the agent got: 200 for a good answer,
          // the upstream's own code for a failure.
          status: String(event.status),
          error: event.error,
        }),
      ),
    });
  },

  /* ---------------- 公布的模型 ---------------- */

  async listPublishedModels() {
    return create(ListPublishedModelsResponseSchema, {
      models: publishedModels().map((model) =>
        create(PublishedModelSchema, {
          id: model.id,
          displayName: model.displayName,
          enabled: model.enabled,
          // 根路由现在真的公布它吗？判据跟根路由一样。
          published: model.published,
          // 没公布的原因。公布了就是 UNSPECIFIED。
          unpublishedReason: model.unpublishedReason,
          strategy: model.strategy,
          // 继承的字段就是没有（契约里 optional）：客户端原样存回去还是继承。
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          toolCall: model.toolCall,
          effortOptions: model.effortOptions,
          // 现算出来的值：面板上显示用，与「库里存的那个」分开。
          effective: create(ModelMetadataSchema, {
            contextWindow: model.effective.contextWindow,
            maxOutputTokens: model.effective.maxOutputTokens,
            reasoning: model.effective.reasoning,
            toolCall: model.effective.toolCall,
            effortOptions: model.effective.effortOptions,
          }),
          updatedAt: BigInt(model.updatedAt),
          targets: model.targets.map((target) =>
            create(PublishedTargetSchema, {
              groupName: target.groupName,
              upstreamModel: target.upstreamModel,
              weight: target.weight,
              enabled: target.enabled,
              requests: BigInt(target.requests),
              failed: BigInt(target.failed),
              // The target the route points at right now: at most one per model.
              current: target.current === true,
              // 为什么接不了，以及什么时候能再接。只读：每次查询现算。
              blocked: target.blocked === true,
              blockedReason: target.blockedReason ?? "",
              recoversAtMs: BigInt(target.recoversAtMs ?? 0),
            }),
          ),
        }),
      ),
    });
  },

  async savePublishedModel(request) {
    const model = request.model;
    if (!model) throw adminError("MODEL_NOT_GIVEN", "request has no model");
    const result = savePublishedModel({
      id: model.id,
      displayName: model.displayName || model.id,
      enabled: model.enabled,
      strategy: model.strategy,
      // 不给就是继承：存 NULL，别把它填死。
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      toolCall: model.toolCall,
      effortOptions: [...model.effortOptions],
      targets: model.targets.map((target) => ({
        groupName: target.groupName,
        upstreamModel: target.upstreamModel,
        weight: target.weight,
        enabled: target.enabled,
      })),
    });
    if (!result.ok) {
      console.log(`[MODEL] 保存 ${result.id} 失败：${result.message}`);
      throw adminError(result.code, result.message);
    }
    console.log(`[MODEL] 保存 ${result.id}：${result.message}`);
    return create(SavePublishedModelResponseSchema, { id: result.id });
  },

  async deletePublishedModel(request) {
    const id = String(request.id ?? "");
    const result = deletePublishedModel(id);
    console.log(`[MODEL] 删除 ${id}：${result.message}`);
    return create(DeletePublishedModelResponseSchema, { ok: result.ok, message: result.message });
  },

  /* ---------------- 每日权益 ---------------- */

  async getBenefitStatus() {
    const state = benefits.lastRun;
    const benefitsOut = benefitUpstreams().map((upstream) => {
      const outcome = state.lastOutcome?.find((o) => o.upstream === upstream);
      if (!outcome) {
        return create(BenefitStatusSchema, {
          upstreamId: upstream,
          summary: "暂无签到记录",
          lines: [],
          checkedAt: 0n,
          credits: 0,
          ok: false,
        });
      }
      // The summary is what the panel shows on the line: what happened, in
      // one line. Five answers, in this order: it did not work; it worked and
      // brought credits; it worked (the credits came earlier today); the
      // platform does not tell us the check-in's state; anything else.
      //
      // "Already claimed" is not one of them: that is an internal wording
      // and it belongs in the details (lines), not in the summary.
      const summary = !outcome.ok
        ? "签到未成功"
        : outcome.signedIn && outcome.credits > 0
          ? `今日已签到 +${outcome.credits}`
          : outcome.signedIn
            ? "今日已签到"
            : outcome.statusUnavailable
              ? "平台不支持"
              : "今日暂无新活动";
      return create(BenefitStatusSchema, {
        upstreamId: upstream,
        summary,
        lines: outcome.report,
        checkedAt: BigInt(Date.parse(outcome.at) || 0),
        credits: outcome.credits,
        ok: outcome.ok,
      });
    });
    return create(GetBenefitStatusResponseSchema, { benefits: benefitsOut });
  },

  async runBenefitNow() {
    await benefits.runOnce();
    const outcomes = benefits.lastRun.lastOutcome ?? [];
    return create(RunBenefitNowResponseSchema, {
      ok: outcomes.length > 0 && outcomes.every((o) => o.ok),
      lines: outcomes.flatMap((o) => [`[${o.upstream}] ${o.report.join("；")}`]),
    });
  },

  /* ---------------- 目录与日志 ---------------- */

  async listModels(request) {
    const models = catalogModels(String(request.upstreamId ?? ""));
    return create(ListModelsResponseSchema, {
      models: models.map((model) =>
        create(CatalogModelSchema, {
          id: model.id,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          toolCall: model.toolCall,
          effortOptions: model.effortOptions,
          // 没人报价就不写这一格：契约里它是 optional，缺键是「不知道」，0 是
          // 「免费」—— 两件事不能在答复里糊成一个。
          ...(model.credits === undefined ? {} : { credits: model.credits }),
          // 上游没报计费就不写这一格（面板据此不显示价格）。它与上面那个 credits
          // 不是一回事，所以不合并、不互相覆盖。
          ...(model.billing === undefined ? {} : { billing: modelBillingMessage(model.billing) }),
        }),
      ),
    });
  },

  async tailLog(request) {
    const lines = tailLog(Number(request.lines ?? 0), String(request.filter ?? ""));
    return create(TailLogResponseSchema, { lines });
  },

  /* ---------------- 登录授权 ---------------- */

  async beginLogin(request) {
    const upstreamId = String(request.upstreamId ?? "");
    try {
      const session = await beginLogin(upstreamId, String(request.accountId ?? ""));
      return create(BeginLoginResponseSchema, {
        session: loginSessionMessage(session),
        ok: true,
        message: session.message,
      });
    } catch (e) {
      return create(BeginLoginResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async getLoginStatus(request) {
    const session = getLoginStatus(String(request.loginId ?? ""));
    if (!session) {
      return create(GetLoginStatusResponseSchema, { ok: false, message: "未找到本次登录。" });
    }
    return create(GetLoginStatusResponseSchema, {
      session: loginSessionMessage(session),
      ok: true,
      message: session.message,
    });
  },

  async cancelLogin(request) {
    const result = cancelLogin(String(request.loginId ?? ""));
    return create(CancelLoginResponseSchema, { ok: result.ok, message: result.message });
  },

  async loginWithPassword(request) {
    try {
      const result = await loginWithPassword({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        username: String(request.username ?? ""),
        password: String(request.password ?? ""),
        captchaVerifyParam: String(request.captchaVerifyParam ?? ""),
        captchaSceneId: String(request.captchaSceneId ?? ""),
        captchaPrefix: String(request.captchaPrefix ?? ""),
        remember: request.remember === true,
      });
      return create(LoginWithPasswordResponseSchema, {
        ok: result.ok,
        message: result.message,
        account: accountMessage(result.accountId),
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(LoginWithPasswordResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async exchangeLoginCode(request) {
    try {
      const result = await exchangeLoginCode({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        code: String(request.code ?? ""),
      });
      return create(ExchangeLoginCodeResponseSchema, {
        ok: result.ok,
        message: result.message,
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(ExchangeLoginCodeResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async importLoginToken(request) {
    try {
      const result = await importLoginToken({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        token: String(request.token ?? ""),
      });
      return create(ImportLoginTokenResponseSchema, {
        ok: result.ok,
        message: result.message,
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(ImportLoginTokenResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },
};
