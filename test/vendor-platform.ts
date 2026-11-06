// test/vendor-platform.ts — 测试里造一行厂商平台。
//
// 生产里厂商那几行（七牛云 / 讯飞星火 / SenseNova / 书生·端砚 / TokenRhythm）
// 是用户在面板上自己建的：代码里不再有平台模板表（lib/platform-catalog.ts），
// 启动时也不补行 —— 库里没有的行就是没有。
//
// 测试要的正是「表里有一行 kind=qiniu 的平台」（账号、凭据、额度都按那一行走），
// 所以自己插一行。插出来的那一行照旧口径来：地址取适配器自己声明的默认地址
// （ProviderKind.defaultBaseUrl），目录照这一类自己的 models() 报的那份。

// 引用即登记：这一格默认地址在 kind 注册表里，读它之前得先让各家登记完。
import "../lib/kinds/index.ts";
import { kindOf } from "../lib/provider-kinds.ts";
import type { ProviderRow } from "../lib/providers.ts";
import { store } from "../lib/store.ts";

/** 一个最小的账号行：models() 只看平台行，不看账号。 */
function bareRow(platform: string, kind: string): ProviderRow {
  return {
    id: "0",
    platform,
    kind,
    region: "",
    alias: "",
    enabled: true,
    weight: 0,
    policy: "single",
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 插一行厂商平台。
 *
 * modelsAuto 不给就照这一类的口径来（目录归上游还是归代码）：代码挑过的那份
 * 不让上游盖上来（上游那份更宽，会出现被上游拒的模型）。
 */
export function insertVendorPlatform(
  kind: string,
  id = kind,
  options: { baseUrl?: string; modelsAuto?: boolean; quotaPlugin?: string; models?: string[] } = {},
): void {
  const declared = kindOf(kind)?.defaultBaseUrl ?? "";
  const baseUrl = options.baseUrl ?? declared;
  if (!baseUrl) throw new Error(`kind ${kind} 没有默认地址，造不出这一行`);
  const modelsAuto = options.modelsAuto ?? kindOf(kind)?.modelsFromUpstream ?? true;
  const catalog = options.models ?? kindOf(kind)?.models(bareRow(id, kind))?.map((model) => model.id) ?? [];
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO platform " +
        "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)",
    )
    .run(
      id,
      id,
      baseUrl,
      JSON.stringify({ items: catalog, traits: {}, fetchedAt: 0, source: "auto" }),
      modelsAuto ? 1 : 0,
      options.quotaPlugin ?? "",
      kind,
      now,
      now,
    );
}
