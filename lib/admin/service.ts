// lib/admin/service.ts — 管理接口的 20 个方法。
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
  BalanceSummarySchema,
  BenefitStatusSchema,
  CatalogModelSchema,
  ConfigItemSchema,
  CredentialSchema,
  CredentialStatusSchema,
  CreditLotSchema,
  DeletePublishedModelResponseSchema,
  GetBalanceResponseSchema,
  GetBenefitStatusResponseSchema,
  GetSystemStatusResponseSchema,
  GetUsageSummaryResponseSchema,
  ListAccountsResponseSchema,
  ListConfigResponseSchema,
  ListCredentialsResponseSchema,
  ListModelsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListUpstreamsResponseSchema,
  ListUsageEventsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
  RefreshCredentialResponseSchema,
  RestartSystemResponseSchema,
  RunBenefitNowResponseSchema,
  SavePublishedModelResponseSchema,
  SetConfigResponseSchema,
  SetUpstreamEnabledResponseSchema,
  TailLogResponseSchema,
  TestCredentialResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamSchema,
  UsageBucketSchema,
  UsageEventSchema,
  UsageSummarySchema,
} from "../gen/buddy/admin/v1/admin_pb.ts";
import { adminTokenSet } from "./token.ts";
import { configItems, knownConfigKeys, pendingRestart, setConfigValue } from "./config.ts";
import {
  UPSTREAM_FLAG_KEYS,
  UPSTREAM_IDS,
  UPSTREAM_LABELS,
  healthSnapshot,
  upstreamBalances,
  upstreamBaseUrl,
  upstreamCredential,
  upstreamModelCount,
  upstreamRegion,
  upstreamStates,
  type BalanceView,
  type UpstreamId,
  type UpstreamState,
} from "./upstreams.ts";
import { listAccounts, listCredentials, refreshCredential, testCredential } from "./accounts.ts";
import { catalogModels, deletePublishedModel, publishedModels, savePublishedModel } from "./models.ts";
import { usageEvents, usageSummary } from "./usage.ts";
import { tailLog } from "./log.ts";
import { benefitUpstreams, benefits } from "./benefits.ts";
import { listAggregateModels } from "../aggregate.ts";
import { configOverride } from "../config.ts";

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

/** 一个余额摘要。 */
function balanceMessage(balance: BalanceView) {
  return create(BalanceSummarySchema, {
    upstreamId: balance.upstreamId,
    accountId: balance.accountId,
    availableCny: balance.availableCny,
    currency: balance.currency,
    lots: balance.lots.map((lot) =>
      create(CreditLotSchema, {
        id: lot.id,
        sourceLabel: lot.sourceLabel,
        remainingCny: lot.remainingCny,
        expiresAt: BigInt(lot.expiresAt),
        status: lot.status,
      }),
    ),
    nextExpiryAt: BigInt(balance.nextExpiryAt),
    expiringCny: balance.expiringCny,
    // 套餐额度：只有 MiniMax 有别的上游不带这个。
    tokenPlan: balance.tokenPlan
      ? create(TokenPlanSchema, {
          windows: balance.tokenPlan.windows.map((window) =>
            create(TokenPlanWindowSchema, {
              label: window.label,
              intervalPercent: window.intervalPercent,
              weeklyPercent: window.weeklyPercent,
              intervalEndsAt: BigInt(window.intervalEndsAt),
              weeklyEndsAt: BigInt(window.weeklyEndsAt),
            }),
          ),
        })
      : undefined,
  });
}

/** 几个余额合成一个（面板上每个上游只显示一个）。 */
function mergeBalances(balances: BalanceView[]): BalanceView | null {
  if (!balances.length) return null;
  return {
    upstreamId: balances[0].upstreamId,
    accountId: balances[0].accountId,
    availableCny: balances.reduce((sum, b) => sum + b.availableCny, 0),
    currency: balances[0].currency,
    lots: balances.flatMap((b) => b.lots),
    nextExpiryAt: balances.reduce((max, b) => Math.max(max, b.nextExpiryAt), 0),
    expiringCny: balances.reduce((sum, b) => sum + b.expiringCny, 0),
    tokenPlan: balances.find((b) => b.tokenPlan)?.tokenPlan,
  };
}

/** 一个上游在面板上的样子。 */
async function upstreamMessage(id: UpstreamId, state: UpstreamState) {
  const credential = upstreamCredential(id);
  const balances = await upstreamBalances(id);
  const balance = mergeBalances(balances);
  return create(UpstreamSchema, {
    id,
    label: UPSTREAM_LABELS[id],
    // 将要生效的值：面板改了但还没重启时，这里已经是改后的值。
    enabled: state.enabled,
    // 改过、还没重启。
    pending: state.pending,
    modelCount: upstreamModelCount(id),
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
    balance: balance ? balanceMessage(balance) : undefined,
    baseUrl: upstreamBaseUrl(id),
    region: upstreamRegion(id),
  });
}

/** 权益的上游名与面板的上游 id 不是一回事（qoder-global → qoder）。 */
function benefitUpstreamId(name: string): string {
  if (name === "qoder-global") return "qoder";
  return name;
}

/** 管理接口的实现。 */
export const adminService: Partial<ServiceImpl<typeof AdminService>> = {
  /* ---------------- 系统 ---------------- */

  async getSystemStatus() {
    // 先看一眼快照：旧了就起一个后台刷新，面板这次拿旧答案、下次拿新的。
    healthSnapshot();
    const states = upstreamStates();
    const upstreams = [];
    for (const id of UPSTREAM_IDS) upstreams.push(await upstreamMessage(id, states[id]));
    return create(GetSystemStatusResponseSchema, {
      version: serviceVersion(),
      upstreams,
      pendingRestart: pendingRestart(),
      uptimeSec: BigInt(Math.round(process.uptime())),
      publishedModelCount: listAggregateModels().length,
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

  /* ---------------- 上游 ---------------- */

  async listUpstreams() {
    const states = upstreamStates();
    const upstreams = [];
    for (const id of UPSTREAM_IDS) upstreams.push(await upstreamMessage(id, states[id]));
    return create(ListUpstreamsResponseSchema, { upstreams });
  },

  async setUpstreamEnabled(request) {
    const id = String(request.upstreamId ?? "");
    const key = UPSTREAM_FLAG_KEYS[id as UpstreamId];
    if (!key) {
      return create(SetUpstreamEnabledResponseSchema, {
        ok: false,
        pendingRestart: pendingRestart(),
        message: `不认识的上游：${id}`,
      });
    }
    configOverride(key, request.enabled ? "true" : "false");
    console.log(`[ADMIN] ${key} 改成 ${request.enabled ? "true" : "false"}（重启后生效）`);
    return create(SetUpstreamEnabledResponseSchema, {
      ok: true,
      pendingRestart: pendingRestart(),
      message: `${UPSTREAM_LABELS[id as UpstreamId]} ${request.enabled ? "开着" : "关了"}，重启后生效`,
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
      message: result.ok ? `${result.message}，重启后生效` : result.message,
    });
  },

  /* ---------------- 账号与凭据 ---------------- */

  async listAccounts() {
    const accounts = listAccounts();
    // 每个账号的余额。余额在快照里，这里不现问上游（那是 GetBalance 的事）。
    const balances = new Map<string, BalanceView>();
    for (const id of UPSTREAM_IDS) {
      for (const balance of await upstreamBalances(id)) {
        balances.set(balance.accountId, balance);
      }
    }
    return create(ListAccountsResponseSchema, {
      accounts: accounts.map((account) => {
        const balance = balances.get(account.id);
        return create(AccountSchema, {
          id: account.id,
          upstreamId: account.upstreamId,
          label: account.label,
          status: account.status,
          credentialCount: account.credentialCount,
          detail: account.detail,
          balance: balance ? balanceMessage(balance) : undefined,
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
          upstreamId: row.upstreamId,
          kind: row.kind,
          label: row.label,
          masked: row.masked,
          fingerprint: row.fingerprint,
          status: row.status,
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

  async refreshCredential(request) {
    const id = String(request.credentialId ?? "");
    const result = await refreshCredential(id);
    return create(RefreshCredentialResponseSchema, {
      ok: result.ok,
      message: result.message,
      generation: result.generation,
    });
  },

  /* ---------------- 余额 ---------------- */

  async getBalance(request) {
    const wanted = String(request.upstreamId ?? "");
    const ids = (wanted ? [wanted] : UPSTREAM_IDS) as UpstreamId[];
    const balances = [];
    for (const id of ids) {
      for (const balance of await upstreamBalances(id, true)) balances.push(balanceMessage(balance));
    }
    return create(GetBalanceResponseSchema, { balances });
  },

  /* ---------------- 用量 ---------------- */

  async getUsageSummary(request) {
    const summary = usageSummary(String(request.upstreamId ?? ""), String(request.window ?? ""));
    return create(GetUsageSummaryResponseSchema, {
      total: create(UsageSummarySchema, {
        requests: BigInt(summary.total.requests),
        succeeded: BigInt(summary.total.succeeded),
        failed: BigInt(summary.total.failed),
        promptTokens: BigInt(summary.total.promptTokens),
        completionTokens: BigInt(summary.total.completionTokens),
        reasoningTokens: BigInt(summary.total.reasoningTokens),
        latencyMsSum: BigInt(summary.total.latencyMsSum),
      }),
      byUpstream: summary.byUpstream.map((bucket) =>
        create(UsageBucketSchema, {
          key: bucket.key,
          summary: create(UsageSummarySchema, {
            requests: BigInt(bucket.summary.requests),
            succeeded: BigInt(bucket.summary.succeeded),
            failed: BigInt(bucket.summary.failed),
            promptTokens: BigInt(bucket.summary.promptTokens),
            completionTokens: BigInt(bucket.summary.completionTokens),
            reasoningTokens: BigInt(bucket.summary.reasoningTokens),
            latencyMsSum: BigInt(bucket.summary.latencyMsSum),
          }),
        }),
      ),
      byModel: summary.byModel.map((bucket) =>
        create(UsageBucketSchema, {
          key: bucket.key,
          summary: create(UsageSummarySchema, {
            requests: BigInt(bucket.summary.requests),
            succeeded: BigInt(bucket.summary.succeeded),
            failed: BigInt(bucket.summary.failed),
            promptTokens: BigInt(bucket.summary.promptTokens),
            completionTokens: BigInt(bucket.summary.completionTokens),
            reasoningTokens: BigInt(bucket.summary.reasoningTokens),
            latencyMsSum: BigInt(bucket.summary.latencyMsSum),
          }),
        }),
      ),
      byDay: summary.byDay.map((bucket) =>
        create(UsageBucketSchema, {
          key: bucket.key,
          summary: create(UsageSummarySchema, {
            requests: BigInt(bucket.summary.requests),
            succeeded: BigInt(bucket.summary.succeeded),
            failed: BigInt(bucket.summary.failed),
            promptTokens: BigInt(bucket.summary.promptTokens),
            completionTokens: BigInt(bucket.summary.completionTokens),
            reasoningTokens: BigInt(bucket.summary.reasoningTokens),
            latencyMsSum: BigInt(bucket.summary.latencyMsSum),
          }),
        }),
      ),
    });
  },

  async listUsageEvents(request) {
    const events = usageEvents(
      String(request.upstreamId ?? ""),
      String(request.model ?? ""),
      Number(request.limit ?? 0),
      Number(request.beforeId ?? 0),
    );
    return create(ListUsageEventsResponseSchema, {
      events: events.map((event) =>
        create(UsageEventSchema, {
          id: BigInt(event.id),
          ts: BigInt(event.ts),
          upstreamId: event.upstreamId,
          model: event.model,
          agentModel: event.agentModel,
          dialect: event.dialect,
          client: event.client,
          promptTokens: BigInt(event.promptTokens),
          completionTokens: BigInt(event.completionTokens),
          reasoningTokens: BigInt(event.reasoningTokens),
          latencyMs: BigInt(event.latencyMs),
          status: event.status,
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
          strategy: model.strategy,
          // 继承的字段就是没有（契约里 optional）：客户端原样存回去还是继承。
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          toolCall: model.toolCall,
          effortOptions: model.effortOptions,
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
      return create(SavePublishedModelResponseSchema, { ok: false, id: "", message: "得有模型" });
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
          upstreamId: benefitUpstreamId(upstream),
          summary: "还没有签到记录",
          lines: [],
          checkedAt: 0n,
          credits: 0,
          ok: false,
        });
      }
      const summary = !outcome.ok
        ? "签到没成"
        : outcome.credits > 0
          ? `今日已签到 +${outcome.credits}`
          : "今天没有新的活动";
      return create(BenefitStatusSchema, {
        upstreamId: benefitUpstreamId(upstream),
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
};
