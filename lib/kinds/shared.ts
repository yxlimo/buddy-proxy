// lib/kinds/shared.ts — what every kind needs.
//
// The registry's shape lives in lib/provider-kinds.ts; it is re-exported here so
// a platform module imports one module for the common part and its own for the
// rest. The plan view is here because two platforms report a plan and both want
// the same shape — and because the video windows are dropped in one place.

import type { CredentialField, CredentialForm, CredentialOwner, CredentialPlan, CredentialSlot } from "../provider-kinds.ts";
import type { TokenPlanView } from "../provider-kinds.ts";
import { isIgnoredPlanWindow } from "../cooldown.ts";
import { providerSecretId } from "../credential-ids.ts";
import { deadSession } from "../session.ts";
import { listSecrets } from "../store.ts";
import { openPlatformOf } from "../open-platforms.ts";
import { quotaPluginOf } from "../quota-plugin-registry.ts";
import { pluginFieldOf, writePluginField } from "../quota-plugin-credentials.ts";
import { openPlatformKeyOf, writeOpenPlatformKey } from "../open-platform-credentials.ts";

export {
  fromUpstreamStatus,
  registerKind,
  type BalanceLotView,
  type CreditLotView,
  type CredentialField,
  type CredentialForm,
  type CredentialOwner,
  type CredentialPlan,
  type CredentialSlot,
  type CredentialView,
  type HealthSnapshot,
  type QuotaView,
  type SlotReading,
  type TokenPlanView,
} from "../provider-kinds.ts";
export { isIgnoredPlanWindow } from "../cooldown.ts";
export type { ProviderRow } from "../providers.ts";

/* ------------------------------------------------------------------ *
 * The credential slots every kind builds from
 * ------------------------------------------------------------------ */

/**
 * secrets 表里那一行的内容与更新时间。
 *
 * 一次只取一行：凭据的 id 是全表唯一的，按前缀列表再把不要的挑出去是那个函数的
 * 用法（列一整片），不是这里的。
 */
export function secretRecord(id: string): { data: any; updatedAt: number } {
  const row = listSecrets(id).find((r) => r.id === id);
  return { data: row?.data ?? null, updatedAt: Number(row?.updatedAt ?? 0) };
}

/**
 * 会话那一段。
 *
 * 模拟客户端那几家（MiniMax Code、Qoder、WorkBuddy、ZCode）与 SenseNova 都是这个
 * 形状：记录在不在决定它配没配，过期与「平台拒过」决定它还能不能用。
 *
 * `load` 给那些要把会话先过一遍自己校验的平台（TokenRhythm 过期与作废的会话算
 * 没有会话）：这样的平台拿不到记录的写入时刻，updatedAt 就是 0。
 */
export function sessionSlot(
  options: {
    label?: string;
    /** 会话记录里哪一段是值：各家字段名不一样。 */
    token?: (raw: any) => string;
    /** 换一种读法：有的平台要先按自己的规矩读一遍会话。 */
    load?: (accountId: string) => any;
  } = {},
): CredentialSlot {
  const defaultToken = (raw: any): string => String(raw?.accessToken ?? raw?.cookie ?? raw?.token ?? "");
  const tokenOf = options.token ?? defaultToken;
  const id = (account: CredentialOwner) => providerSecretId(account.id);
  const rawOf = (account: CredentialOwner): { raw: any; updatedAt: number } => {
    if (options.load) return { raw: options.load(account.id), updatedAt: 0 };
    const record = secretRecord(id(account));
    return { raw: record.data, updatedAt: record.updatedAt };
  };
  return {
    label: options.label ?? "登录会话",
    form: "session",
    alwaysList: true,
    read: (account) => {
      const { raw, updatedAt } = rawOf(account);
      return {
        id: id(account),
        present: raw != null,
        value: tokenOf(raw),
        updatedAt,
        session: {
          expiresAt: Number(raw?.expiresAtMs ?? 0),
          generation: Number(raw?.generation ?? 0),
          lastOkAt: Number(raw?.refreshedAtMs ?? raw?.obtainedAtMs ?? raw?.loginAtMs ?? 0),
          refused: Boolean(deadSession(id(account))),
        },
      };
    },
  };
}

/**
 * 只有一把令牌的会话（书生·端砚）：没有过期时间，也没有代数。
 *
 * 它不是会话那份形状：记录里只有一个 token，「有 token」就是配好了。硬套
 * sessionSlot 的话，记录在而 token 空的时候会被算成能用 —— 那是把「没配」说成
 * 「能用」。
 */
export function tokenSlot(options: { label?: string } = {}): CredentialSlot {
  const id = (account: CredentialOwner) => providerSecretId(account.id);
  return {
    label: options.label ?? "登录会话",
    form: "session",
    alwaysList: true,
    read: (account) => {
      const record = secretRecord(id(account));
      const token = String(record.data?.token ?? "");
      return {
        id: id(account),
        present: token !== "",
        value: token,
        updatedAt: record.updatedAt,
        session: {
          expiresAt: 0,
          generation: 0,
          lastOkAt: Number(record.data?.obtainedAtMs ?? 0),
          refused: false,
        },
      };
    },
  };
}

/**
 * 段放在记录里某个位置上的凭据（key、cookie 那些）。
 *
 * 没有值就是没配，也不列那一行：面板上不能出现「有凭据」却没有凭据的行。
 */
export function valueSlot(options: {
  label: string;
  form: CredentialForm;
  id(account: CredentialOwner): string;
  value(account: CredentialOwner): string;
  updatedAt?(account: CredentialOwner): number;
  alwaysList?: boolean;
}): CredentialSlot {
  return {
    label: options.label,
    form: options.form,
    alwaysList: options.alwaysList,
    read: (account) => {
      const value = options.value(account);
      return {
        id: options.id(account),
        present: value !== "",
        value,
        updatedAt: options.updatedAt?.(account) ?? 0,
      };
    },
  };
}

/**
 * 一个不填格、也不收 key 的种类（凭据是登录会话的那种）。
 *
 * `noKeyNote` 只有 MiniMax Code 用：面板已经习惯了「这一类不收 key」这个答复，
 * 换一句话就是换了它看到的意思。
 */
export function sessionOnlyPlan(options: { title: string; noKeyNote?: string } = { title: "" }): CredentialPlan {
  return {
    title: options.title,
    noKeyNote: options.noKeyNote,
    slots: () => [sessionSlot()],
    fields: () => [],
    write: () => 0,
  };
}

/** 一个「一把 key、面板上一格」的种类的声明。 */
export function keyPlan(options: {
  title: string;
  slots(account: CredentialOwner): CredentialSlot[];
  field: CredentialField;
  write(account: CredentialOwner, value: string): number;
}): CredentialPlan {
  return {
    title: options.title,
    slots: options.slots,
    fields: () => [options.field],
    write: (account, values) => options.write(account, String(values[0] ?? "")),
  };
}

/* ------------------------------------------------------------------ *
 * The open platform: a key plus whatever the quota plugin wants
 * ------------------------------------------------------------------ */

/**
 * 开放平台的凭据：一把推理 key，加上平台所选额度插件要的那几段。
 *
 * 两件事分开：
 *
 *   · 推理 key 那一格是**种类自己定死的**，与平台行无关 —— 没有平台上下文
 *     （面板问「有哪些种类」）时也得给得出它。曾经这里一查到不到平台行就整份
 *     返回空数组，于是面板一格也画不出来、保存被段数校验挡下。
 *   · 插件那几段是**数据**不是代码：插件由平台那一行指名，所以几段、叫什么名字
 *     到运行时才定得下来。拿不到平台行就不算这几段（没平台就没有「这个平台选了
 *     哪个插件」这回事）。
 *
 * 插件那一格叫什么名字只有一处产出：插件自己的声明（QuotaField.label）。凭据行
 * 与面板那一格读的是同一个值，这边不再按 label 里有没有 cookie 猜一遍。
 *
 * 插件那几段只用来问额度，不是推理凭据：能拿去推理的只有那把 key。
 */
export function openPlatformPlan(): CredentialPlan {
  const pluginOf = (account: CredentialOwner) =>
    quotaPluginOf(openPlatformOf(account.platform)?.quotaPlugin?.trim() ?? "");
  const fieldsOf = (account: CredentialOwner) => pluginOf(account)?.fields ?? [];
  const keyId = (owner: CredentialOwner) => providerSecretId(owner.id, "key");
  /** 种类自己定死的那一格：推理用的 key。只有这一份声明。 */
  const keyField: CredentialField = {
    name: "api-key",
    label: "推理 Key",
    hint: "发模型请求用的那一把；留空表示清掉它",
    placeholder: "sk-…",
  };
  const fieldSlots = (account: CredentialOwner): CredentialSlot[] =>
    fieldsOf(account).map((field) =>
      valueSlot({
        label: field.label,
        form: "cookie",
        id: (owner) => providerSecretId(owner.id, field.name),
        value: (owner) => pluginFieldOf(owner.id, field.name),
        updatedAt: (owner) => secretRecord(providerSecretId(owner.id, field.name)).updatedAt,
        alwaysList: true,
      }),
    );
  return {
    title: "开放平台的凭据",
    // 段数由额度插件决定，所以要点出来：面板的登记表没到手时它发来的数组会短，
    // 那时候一个字段也不能写。
    dynamicFields: true,
    // 一个平台一种业务：种类名只能说「开放平台」，名字得从平台那一行取。
    name: (account) => openPlatformOf(account.platform)?.label ?? "开放平台",
    slots: (account) => {
      if (!openPlatformOf(account.platform)) return [];
      return [
        valueSlot({
          label: keyField.label,
          form: "api_key",
          id: keyId,
          value: (owner) => String(openPlatformKeyOf(owner.id)?.apiKey ?? ""),
          updatedAt: (owner) => secretRecord(keyId(owner)).updatedAt,
        }),
        ...fieldSlots(account),
      ];
    },
    // 推理那一格无条件给（种类定死的）；插件那几段只在拿到平台行时接在后面。
    fields: (account) => {
      const plugin = pluginOf(account);
      if (!openPlatformOf(account.platform)) return [keyField];
      return [
        keyField,
        ...fieldsOf(account).map((field) => ({
          name: field.name,
          // label 是给人看的名字；name 是库里的后缀，不给人看。
          label: field.label,
          hint: `额度插件「${plugin?.label || plugin?.id || ""}」要的一段凭据`,
        })),
      ];
    },
    // 位置就是顺序：第一格是推理用的 key（它有自己的位置 :key），后面几格按
    // 平台所选插件的 fields 顺序，一段一段写进插件要的那个位置。空的那段表示
    // 清掉它。
    write: (account, values) => {
      let count = writeOpenPlatformKey(account.id, String(values[0] ?? ""));
      const fields = fieldsOf(account);
      for (let i = 0; i < fields.length; i++) {
        if (writePluginField(account.id, fields[i].name, String(values[i + 1] ?? ""))) count++;
      }
      return count;
    },
  };
}

/**
 * MiniMax 的套餐额度。
 *
 * 平台给的是 ISO 字符串，这里换成毫秒时间戳。到期时间没有就是 0。
 */
export function tokenPlanView(plan: unknown): TokenPlanView | undefined {
  const raw = plan as any;
  const all = Array.isArray(raw?.windows) ? raw.windows : [];
  const windows = all.filter((w: any) => !isIgnoredPlanWindow(w));
  if (!windows.length) return undefined;
  const at = (value: unknown): number => {
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    windows: windows.map((window: any) => ({
      label: String(window?.model ?? ""),
      intervalPercent: Math.round(Number(window?.intervalPercent ?? 0)),
      weeklyPercent: Math.round(Number(window?.weeklyPercent ?? 0)),
      intervalEndsAt: at(window?.intervalEndsAt),
      weeklyEndsAt: at(window?.weeklyEndsAt),
    })),
  };
}
