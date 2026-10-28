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
  ListProviderKindsResponseSchema,
  ProviderKindSchema,
  ListCredentialsResponseSchema,
  ListModelsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListUpstreamsResponseSchema,
  ListUsageEventsResponseSchema,
  LoginSessionSchema,
  LoginWithPasswordResponseSchema,
  PublishedModelSchema,
  ModelMetadataSchema,
  PublishedTargetSchema,
  RefreshCredentialResponseSchema,
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
  UpdateProviderResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UsageBucketSchema,
  UsageEventSchema,
  UsageSummarySchema,
} from "../gen/buddy/admin/v1/admin_pb.ts";
import { adminTokenSet } from "./token.ts";
import { configItems, knownConfigKeys, pendingRestart, setConfigValue } from "./config.ts";
import {
  forgetAccountSnapshot,
  healthSnapshot,
  setAccountEnabled,
  upstreamQuota,
  upstreamQuotas,
  upstreamAccountCount,
  upstreamBaseUrl,
  upstreamCredential,
  upstreamModelCount,
  upstreamPolicy,
  upstreamRegion,
  upstreamState,
  upstreamCooling,
  type QuotaView,
  type UpstreamId,
} from "./upstreams.ts";
import { coolingOf } from "./upstream-state.ts";
import {
  deleteAccount,
  listAccounts,
  listCredentials,
  logoutAccount,
  refreshCredential,
  testCredential,
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
  accountsOfPlatform,
  addAccount,
  listProviders,
  provider,
  updateProvider,
} from "../providers.ts";
import { PLATFORMS, platformOf, platformPolicies, platformPolicy, setPlatformPolicy as writePlatformPolicy } from "../platforms.ts";
import { kindOf, selectableKinds } from "../provider-kinds.ts";
import { policyEnum, policyErrorText, policyFromEnum, POLICY_LABELS } from "./policy.ts";
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

/** 一个额度摘要。 */
export function quotaMessage(quota: QuotaView) {
  return create(UpstreamQuotaSchema, {
    upstreamId: quota.upstreamId,
    accountId: quota.accountId,
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
  });
}

/**
 * 一个平台在面板上的样子。
 *
 * 平台是代码里的模板（九个服务），所以这一条永远在；它名下的账号是数据，
 * 有几个算几个 —— 一个没有就是空的账号列表。
 */
function platformMessage(id: string) {
  const template = platformOf(id);
  const credential = upstreamCredential(id);
  const quota = upstreamQuota(id);
  // 冷却：路由绕开这个账号到什么时候，面板要看得见。
  const cooling = upstreamCooling(id);
  return create(UpstreamSchema, {
    id,
    // 平台的名字是模板里的那个（“Qoder（全球区）”）—— 账号的别名不能顶在这里：
    // 一个平台下有几个账号时，用哪个的别名都是错的。
    label: template?.label ?? id,
    kind: template?.kind ?? "",
    // 现在在生效的值：名下有没有开着的账号。平台自己没有开关，开关在账号上。
    enabled: accountsOfPlatform(id).some((row) => row.enabled),
    // 名下的多个账号怎么选。策略在平台层。
    policy: upstreamPolicy(id),
    // 这个平台支持哪几个策略：面板只给它支持的那几个。
    policies: platformPolicies(id).map(policyEnum),
    // 名下有几个账号。面板用它判「策略有没有用」。
    accountCount: upstreamAccountCount(id),
    // 名下有没有开着的账号 —— 跟 enabled 同一个答案，两个名字一个是给机器判
    // 断用的、一个是给面板画开关用的，别让它们各说各话。
    hasEnabledAccount: accountsOfPlatform(id).some((row) => row.enabled),
    // 现在能不能接：额度用尽、正在登录这些面板自己拼不出来的事，后端知道。
    state: upstreamState(id),
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
    quota: quota ? quotaMessage(quota) : undefined,
    baseUrl: upstreamBaseUrl(id),
    region: upstreamRegion(id),
    // 冷却：名下最早到期的那个账号、最早能再接的时刻、一句话。
    cooldownUntilMs: BigInt(cooling.cooldownUntilMs),
    cooldownReason: cooling.cooldownReason,
    recoversAtMs: BigInt(cooling.recoversAtMs),
    stateReason: cooling.stateReason,
    accounts: accountsOfPlatform(id).flatMap((row) => {
      const account = accountRowMessage(row.id);
      return account ? [account] : [];
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
  return accountRowMessage(accountId);
}

/** 一个账号行，面板看的形状。 */
function accountRowMessage(accountId: string) {
  const row = listAccounts().find((a) => a.id === accountId);
  if (!row) return undefined;
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
    quota: quota ? quotaMessage(quota) : undefined,
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

/** 九个平台，面板看的那一层。 */
function platformMessages() {
  return PLATFORMS.flatMap((platform) => {
    const message = platformMessage(platform.id);
    return message ? [message] : [];
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
      message: "进程正在退出，容器会把它拉起来。前端稍后重连。",
    });
  },

  /* ---------------- 平台与账号 ---------------- */

  async listUpstreams() {
    // 列表是代码里的那九个模板，不是数据库的：平台删不掉，账号才是数据 ——
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
        }),
      ),
    });
  },

  async addAccount(request) {
    const result = addAccount({
      platform: String(request.platform ?? ""),
      alias: String(request.alias ?? ""),
    });
    if (result.ok) console.log(`[ADMIN] 在 ${request.platform} 下加了账号 ${result.id}`);
    return create(AddAccountResponseSchema, {
      ok: result.ok,
      message: result.message,
      id: result.id ?? "",
    });
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
      return create(SetConfigResponseSchema, { ok: false, pendingRestart: pendingRestart(), message: "得有键" });
    }
    if (!knownConfigKeys().has(key)) {
      return create(SetConfigResponseSchema, {
        ok: false,
        pendingRestart: pendingRestart(),
        message: `不认识的配置项：${key}`,
      });
    }
    const result = setConfigValue(key, String(request.value ?? ""), request.clear === true);
    console.log(`[ADMIN] 配置 ${key}：${result.message}`);
    return create(SetConfigResponseSchema, {
      ok: result.ok,
      pendingRestart: pendingRestart(),
      message: result.ok ? `${result.message}，已经生效` : result.message,
    });
  },

  /* ---------------- 账号与凭据 ---------------- */

  async listAccounts() {
    const accounts = listAccounts();
    // 每个账号的额度。额度在快照里，这里不现问上游（那是 GetBalance 的事）。
    const quotas = new Map<string, QuotaView>();
    for (const row of listProviders()) {
      const id = row.id;
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
          quota: quota ? quotaMessage(quota) : undefined,
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
    // 各分支自己决定怎么处理空串：minimax 取第一段、minimax-api 跳过空的那几把。
    const keys = (request.keys ?? []).map((k) => String(k).trim());
    const result = setProviderKeys(upstreamId, keys);
    return create(SetProviderKeysResponseSchema, {
      ok: result.ok,
      message: result.message,
      count: result.count,
    });
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
    const ids = wanted ? [wanted] : listProviders().map((p) => p.id);
    const quotas = [];
    for (const id of ids) {
      for (const quota of await upstreamQuotas(id, true)) quotas.push(quotaMessage(quota));
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
            }),
          ),
        }),
      ),
    });
  },

  async savePublishedModel(request) {
    const model = request.model;
    if (!model) {
      return create(SavePublishedModelResponseSchema, { ok: false, id: "", message: "需要提供模型" });
    }
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
    console.log(`[MODEL] 保存 ${result.id}：${result.message}`);
    return create(SavePublishedModelResponseSchema, {
      ok: result.ok,
      id: result.id,
      message: result.ok ? `${result.message}，已经生效` : result.message,
    });
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
      const summary = !outcome.ok
        ? "签到未成功"
        : outcome.credits > 0
          ? `今日已签到 +${outcome.credits}`
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
          credits: model.credits,
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
