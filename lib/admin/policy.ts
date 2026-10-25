// lib/admin/policy.ts — 生效策略在面板上的样子。
//
// 策略是「一个上游名下的多个账号怎么选」，三个值存在 provider 表的 policy 列里
// （single / fallback / expiry_first）。这里是它跟契约里的枚举之间的翻译。
//
// 「哪一类上游支持哪几个策略」不在这里：那是种类的属性，登记在
// lib/provider-kinds.ts 里（面板的选项从那里来，服务端也用它校验）。

import { ProviderPolicy as ContractPolicy } from "../gen/buddy/admin/v1/admin_pb.ts";
import type { ProviderPolicy } from "../providers.ts";

/**
 * 面板上的名字。给错的时候要说给人听，所以中文在这里只有一份。
 *
 * 面板那份在 web/src/features/upstreams/provider-policy.tsx（POLICY_LABELS）。
 * 契约里没有 label 字段，只能各写一份 —— 两边要一起改：后端的 toast
 * （策略改成了降级）与面板的下拉是同屏出现的。
 */
export const POLICY_LABELS: Record<ProviderPolicy, string> = {
  single: "单一",
  fallback: "降级",
  expiry_first: "余额到期优先",
};

/** 库里存的策略 → 契约里的枚举。 */
export function policyEnum(policy: ProviderPolicy): ContractPolicy {
  switch (policy) {
    case "fallback":
      return ContractPolicy.FALLBACK;
    case "expiry_first":
      return ContractPolicy.EXPIRY_FIRST;
    default:
      return ContractPolicy.SINGLE;
  }
}

/**
 * 契约里的枚举 → 库里存的策略。
 *
 * 不认识的（UNSPECIFIED，或者别的数字）就是 null：那是「没给」或者「给错了」。
 */
export function policyFromEnum(value: number): ProviderPolicy | null {
  switch (value) {
    case ContractPolicy.SINGLE:
      return "single";
    case ContractPolicy.FALLBACK:
      return "fallback";
    case ContractPolicy.EXPIRY_FIRST:
      return "expiry_first";
    default:
      return null;
  }
}

/** 策略给错了的时候回给面板的话：说清楚只认哪三个。 */
export function policyErrorText(value: unknown): string {
  return (
    `不认识的策略：${String(value)}。` +
    `只能选 ${POLICY_LABELS.single}（single）、${POLICY_LABELS.fallback}（fallback）、` +
    `${POLICY_LABELS.expiry_first}（expiry_first）`
  );
}

/** 一个策略的两种叫法：面板上给人看的与库里存的。 */
export function policyText(policy: ProviderPolicy): string {
  return `${POLICY_LABELS[policy]}（${policy}）`;
}

/**
 * 这一类上游不支持这个策略的时候回给面板的话：说清楚支持哪几个。
 *
 * 策略是「名下的多个账号怎么选」，只有一个账号的上游选了也没有用 —— 所以
 * 那一类只给「单一」。
 */
export function unsupportedPolicyText(
  kindLabel: string,
  policy: ProviderPolicy,
  supported: ProviderPolicy[],
): string {
  return (
    `${kindLabel} 这一类上游不支持「${POLICY_LABELS[policy]}」。` +
    `能选的是：${supported.map(policyText).join("、")}`
  );
}
