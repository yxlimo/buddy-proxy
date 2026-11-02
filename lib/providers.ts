// lib/providers.ts — 账号：一行一个登录身份。
//
// 平台是代码里的模板（lib/platforms.ts）：九个服务，路径里那一段就是它的 id。
// 账号是这张表里的行：同一个平台下可以有多行 —— MiniMax Code 的主账号与 M
// plan 是两行，中转站的每个租户也是一行。
//
// 一行有三个来处：
//
//   id        账号自己的标识，自动生成（`minimax`、`minimax-2`）。路径里不用它。
//   platform  它属于哪个平台。平台决定 kind、region 与说话的方式。
//   alias     面板上用来分辨两个账号。
//
// kind 与 region 是从平台模板**派生**的，不是存的：它们是服务的属性，不是
// 哪个登录的身份。

import { store } from "./store.ts";
import { kindOf, type ProviderKind } from "./provider-kinds.ts";
import { PLATFORMS, platformOf, platformPolicy } from "./platforms.ts";

/** 一个账号。 */
export interface ProviderRow {
  /** 账号 id。路径里不用它，路径里是平台 id。 */
  id: string;
  /** 它属于哪个平台：九个模板之一，也是路径里那一段。 */
  platform: string;
  /** 派生自平台：怎么跟它说话。 */
  kind: string;
  /** 派生自平台：区域。 */
  region: string;
  /** 用来分辨同一个平台的两个账号。 */
  alias: string;
  /** 开关。 */
  enabled: boolean;
  /**
   * 权重：大的先试。
   *
   * 降级时按它排：谁先、谁后。同权重按建出来的先后。
   */
  weight: number;
  /** 派生自平台：这个平台的生效策略。 */
  policy: ProviderPolicy;
  createdAt: number;
  updatedAt: number;
}

/**
 * The policy that decides which of an upstream's accounts takes a request.
 *
 * `single`      one account, always the first.
 * `fallback`    try them in order; an account that cannot serve the request
 *               hands it to the next one.
 * `expiry_first` one account: the one whose balance runs out first. Only the
 *               relay stations have balances, so this is theirs alone.
 *
 * The column has no per-kind default: the code does not know which upstream
 * has several accounts and which one has a balance, so the operator sets it.
 */
export type ProviderPolicy = "single" | "fallback" | "expiry_first";

/** Every policy there is. */
export const PROVIDER_POLICIES: ProviderPolicy[] = ["single", "fallback", "expiry_first"];

/** Is this one of the policies? The setter refuses anything else. */
export function isProviderPolicy(value: unknown): value is ProviderPolicy {
  return typeof value === "string" && (PROVIDER_POLICIES as string[]).includes(value);
}

/**
 * 全部账号，按平台排；同一平台里权重大的在前，同权重按建出来的先后。
 */
export function listProviders(): ProviderRow[] {
  const rows = store()
    .prepare(
      "SELECT id, platform, alias, enabled, weight, created_at, updated_at " +
        "FROM provider ORDER BY platform, weight DESC, created_at, id",
    )
    .all() as any[];
  return rows.map(toRow);
}

/**
 * 某个平台下的账号，按权重排：大的先试。
 *
 * 这是降级时的次序 —— 「先调谁、谁接不了换谁」。
 */
export function accountsOfPlatform(platform: string): ProviderRow[] {
  return listProviders().filter((row) => row.platform === platform);
}

/** 某一个账号。 */
export function provider(id: string): ProviderRow | null {
  const row = store()
    .prepare("SELECT id, platform, alias, enabled, weight, created_at, updated_at FROM provider WHERE id = ?")
    .get(id) as any;
  return row ? toRow(row) : null;
}

function toRow(row: any): ProviderRow {
  const platform = String(row.platform ?? "");
  const template = platformOf(platform);
  return {
    id: String(row.id),
    platform,
    kind: template?.kind ?? "",
    region: template?.region ?? "",
    alias: String(row.alias ?? ""),
    enabled: Number(row.enabled) !== 0,
    weight: Number(row.weight ?? 100),
    policy: platformPolicy(platform),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** A policy value from the database; anything unknown means 'single'. */
function policyOfValue(value: unknown): ProviderPolicy {
  const raw = String(value ?? "single");
  return (PROVIDER_POLICIES as string[]).includes(raw) ? (raw as ProviderPolicy) : "single";
}

/**
 * 这个平台的生效策略：它名下的几个账号怎么选。
 *
 * 传平台 id 或账号 id 都行 —— 路由那边拿到的是平台 id，适配器手里有时是
 * 账号行。
 */
export function policyOf(idOrPlatform: string): ProviderPolicy {
  const platform = platformOf(idOrPlatform) ? idOrPlatform : provider(idOrPlatform)?.platform;
  return platform ? platformPolicy(platform) : "single";
}

/**
 * 改一个 provider 的别名、开关与生效策略。
 *
 * 策略没给就是不改：面板只改开关的时候不能把策略顺手抹掉。
 */
export function updateProvider(
  id: string,
  patch: { alias?: string; enabled?: boolean; weight?: number },
): { ok: boolean; message: string } {
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}` };
  const alias = patch.alias === undefined ? row.alias : String(patch.alias).trim();
  const enabled = patch.enabled === undefined ? row.enabled : patch.enabled;
  // 权重是整数，可以是负的（负的排最后）。太大的没有意义，收到 10000。
  const weight = patch.weight === undefined ? row.weight : Math.max(-10000, Math.min(10000, Math.round(patch.weight)));
  store()
    .prepare("UPDATE provider SET alias = ?, enabled = ?, weight = ?, updated_at = ? WHERE id = ?")
    .run(alias, enabled ? 1 : 0, weight, Date.now(), id);
  return { ok: true, message: "改好了" };
}

/**
 * 在一个平台下加一个账号。
 *
 * id 是自动起的：平台 id 后面接序号（`minimax`、`minimax-2`、`minimax-3`……）。
 * 路径里用的是平台 id，所以账号 id 只要不重就行，不需要人取名。
 */
export function addAccount(input: {
  platform: string;
  alias?: string;
}): { ok: boolean; message: string; id?: string } {
  const platform = String(input.platform ?? "").trim();
  if (!platformOf(platform)) {
    return { ok: false, message: `没有这个平台：${platform}。可选：${PLATFORMS.map((p) => p.id).join("、")}` };
  }
  const id = nextAccountId(platform);
  const now = Date.now();
  const existing = accountsOfPlatform(platform).length;
  const alias = String(input.alias ?? "").trim() || `${platformOf(platform)?.label}${existing ? ` ${existing + 1}` : ""}`;
  // 新账号排在现有的后面：权重比现在最小的那个再低一点。
  const lowest = accountsOfPlatform(platform).reduce((min, row) => Math.min(min, row.weight), 100);
  const weight = Math.max(1, lowest - 10);
  store()
    .prepare(
      "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
    )
    .run(id, platform, alias, weight, now, now);
  return { ok: true, message: `加好了：${alias}`, id };
}

/**
 * 这个平台下一个账号 id：序号只往上走，删掉的号不再发。
 *
 * 号要是复用，删掉的账号留下的任何东西（还在等的登录、进程里的缓存、别处
 * 漏删的一条记录）都会落到新账号头上 —— 新账号开局就继承了别人的身份。所以
 * 每个平台记一个「发过的最大序号」（account_seq 表），新号从它往后排。
 *
 * 为什么记序号而不是查历史 id：删账号要删干净（AGENTS.md），库里不该留着
 * 删掉的 id 让人查；一个计数器什么身份都不带。没有计数器的旧库从现有的行
 * 起算（那之前删掉的号无从知道，只能从现在开始不复用）。
 *
 * id 的形状不变（`minimax`、`minimax-2`……）：路径里不用它，但日志、凭据 id
 * 与面板都认这个形状。
 */
function nextAccountId(platform: string): string {
  const db = store();
  const row = db.prepare("SELECT last FROM account_seq WHERE platform = ?").get(platform) as
    | { last?: number }
    | undefined;
  let n = Math.max(Number(row?.last ?? 0), highestAccountNumber(platform)) + 1;
  // 兜底：手工插过的行、别的平台恰好占了这个 id，都往后让。
  while (provider(accountIdOf(platform, n))) n++;
  db.prepare(
    "INSERT INTO account_seq (platform, last) VALUES (?, ?) ON CONFLICT(platform) DO UPDATE SET last = excluded.last",
  ).run(platform, n);
  return accountIdOf(platform, n);
}

/** 第 n 个账号的 id。第一个就是平台 id 本身。 */
function accountIdOf(platform: string, n: number): string {
  return n === 1 ? platform : `${platform}-${n}`;
}

/** 这个平台现有的账号里最大的序号（没有账号就是 0）。 */
function highestAccountNumber(platform: string): number {
  let highest = 0;
  for (const row of accountsOfPlatform(platform)) {
    if (row.id === platform) highest = Math.max(highest, 1);
    const tail = row.id.startsWith(`${platform}-`) ? row.id.slice(platform.length + 1) : "";
    if (/^\d+$/.test(tail)) highest = Math.max(highest, Number(tail));
  }
  return highest;
}

/**
 * Forget the credentials of a provider.
 *
 * The ids follow the pattern `session:provider:<id>`,
 * `key:provider:<id>…` and `account:<id>…`. The boundary is the colon: a
 * provider named `minimax` owns `key:provider:minimax:plan`, but not
 * `session:provider:qiniu` nor `session:provider:minimax-code-m-plan`
 * — those belong to providers of their own.
 *
 * The prefix is compared literally (`substr`), not with LIKE: an account id
 * may carry `_`, which LIKE would read as a wildcard.
 *
 * The legacy relay-station rows are numbered by tenant, and they sit under
 * the first account's prefixes: `key:provider:tokenrhythm:tenant-2` and
 * `account:tokenrhythm:2` belong to `tokenrhythm-2`, not to `tokenrhythm`.
 * So the sweep leaves every tenant-numbered row alone; deleting an account
 * removes only its own tenant's rows, by exact id
 * (lib/tokenrhythm/accounts.ts, forgetLegacyTenantRecords).
 */
export function deleteProviderCredentials(id: string): number {
  const db = store();
  // Only the first relay-station account has tenant rows under its prefixes
  // (its id is the platform id the old shape numbered the tenants under).
  const relay = platformOf(id)?.kind === "tokenrhythm";
  const never = /(?!)/;
  const owned: { exact: string; tenantRow: RegExp }[] = [
    { exact: `session:provider:${id}`, tenantRow: never },
    { exact: `key:provider:${id}`, tenantRow: relay ? /^tenant-\d+$/ : never },
    { exact: `account:${id}`, tenantRow: relay ? /^\d+$/ : never },
  ];
  let dropped = 0;
  for (const { exact, tenantRow } of owned) {
    // The exact id, and the ones below it (`<prefix>:<suffix>`).
    const below = `${exact}:`;
    const rows = db
      .prepare("SELECT id FROM secrets WHERE id = ? OR substr(id, 1, ?) = ?")
      .all(exact, below.length, below) as { id?: string }[];
    for (const row of rows) {
      const secretId = String(row.id ?? "");
      if (secretId !== exact && tenantRow.test(secretId.slice(below.length))) continue;
      dropped += Number(db.prepare("DELETE FROM secrets WHERE id = ?").run(secretId).changes ?? 0);
    }
  }
  return dropped;
}

/**
 * 删一个账号的行。
 *
 * 只删行：凭据不归这一层管（各家平台的凭据长什么样不一样，那边知道）。
 * 删账号要连凭据一起删的话，走 admin 层那个（lib/admin/accounts.ts）。
 */
export function deleteProviderRow(id: string): { ok: boolean; message: string } {
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}` };
  store().prepare("DELETE FROM provider WHERE id = ?").run(id);
  return { ok: true, message: "删掉了" };
}

/** 开关。 */
export function providerEnabled(id: string): boolean {
  return provider(id)?.enabled ?? false;
}

/** 改开关。 */
export function setProviderEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  return updateProvider(id, { enabled });
}

// 凭据的 id 算法在叶子模块里（lib/credential-ids.ts）：zcode/auth.ts 要用它，
// 从这里引会把各平台都拖进来（那边有模块循环），单独 import 它就会崩。
// 这里继续转出去，调用方不用改。
export { providerSecretId } from "./credential-ids.ts";

/** 它的 kind 在注册表里的那一条。 */
export function providerKindOf(id: string): ProviderKind | null {
  const row = provider(id);
  return row ? kindOf(row.kind) : null;
}
