// test/vendor-platform.ts — 测试里造一行厂商平台。
//
// 生产里厂商那几行（七牛云 / 讯飞星火 / SenseNova / 书生·端砚 / TokenRhythm）
// 面板上**不再提供新建**：它们只能来自存量行，或者经接口直接建。它们的 kind
// 已经退场（lib/store.ts 的 migrateLegacyVendorKinds 把存量行改成 `openai` +
// 行上写死的默认地址），所以测试造的也是迁移后的形状：kind 是 `openai`，地址
// 是各家的常量地址（与迁移写进库里的那一份一致），凭据按迁移后的位置
// （推理 key 在 `key:provider:<账号>:key`）。

import { store } from "../lib/store.ts";

/**
 * 厂商那几家行上指的额度插件（kind=openai，插件是按行挂的）。星火没有额度
 * 接口，不指。与 lib/quota-plugin-registry.ts 登记的插件 id 一字不差。
 */
export const VENDOR_QUOTA_PLUGINS: Readonly<Record<string, string>> = {
  qiniu: "qiniu",
  xinghuo: "",
  sensenova: "sensenova-pools",
  "intern-ai": "intern-ai-credits",
  tokenrhythm: "tokenrhythm-wallet",
};

/**
 * 五家厂商的默认推理地址。与 lib/store.ts 的 LEGACY_VENDOR_KINDS 一字不差：
 * 迁移把这些地址写进行里，测试造的行也用同一份 —— 两处不一致的话，测的就不是
 * 生产会跑出来的形状。
 */
const VENDOR_BASE_URLS: Record<string, string> = {
  qiniu: "https://api.qnaigc.com/v1",
  xinghuo: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  sensenova: "https://token.sensenova.cn/v1",
  "intern-ai": "https://discovery-api.intern-ai.org.cn/v1",
  tokenrhythm: "https://tokenrhythm.studio/v1",
};

/**
 * 插一行厂商平台（迁移后的形状：kind = `openai`，地址取常量表）。
 *
 * 目录是空的：目录从上游拉（这一族是方言族），建行的时候不预填 —— 面板上刷一次
 * 才有。额度插件跟着行走（quota_plugin 不随 kind 迁移），调用方要哪家用哪家的。
 */
export function insertVendorPlatform(
  kind: string,
  id = kind,
  options: { baseUrl?: string; quotaPlugin?: string } = {},
): void {
  const declared = VENDOR_BASE_URLS[kind] ?? "";
  const baseUrl = options.baseUrl ?? declared;
  if (!baseUrl) throw new Error(`kind ${kind} 没有默认地址，造不出这一行`);
  const now = Date.now();
  // 幂等：预置的平台（模拟客户端那一族）启动时已经被播种了，同样的 id 再插一次
  // 会撞 UNIQUE。这里存的是「保证这一行在，且是测试要的那个形状」——已存在就覆盖。
  store()
    .prepare(
      "INSERT INTO platform " +
        "(id, label, base_url, models, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'openai', '', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, kind = excluded.kind, " +
        "quota_plugin = excluded.quota_plugin, updated_at = excluded.updated_at",
    )
    .run(
      id,
      id,
      baseUrl,
      JSON.stringify({ items: [], traits: {}, fetchedAt: 0 }),
      options.quotaPlugin ?? "",
      now,
      now,
    );
}
