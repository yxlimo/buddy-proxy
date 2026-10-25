// lib/admin/config.ts — 配置项的说明，以及面板改配置的那条路。
//
// 设置有三个来源：数据库（面板写的）、环境（部署写的）、代码里的默认值。
// 面板看到的是这三个来源合成之后的样子，并且要标出每个值是从哪来的 ——
// 不然改了 env 也不知道到底谁说了算。
//
// 面板能改的那几个是热的：写进数据库之后重新读一遍，下一个请求就是新的值。
// 服务自己内部的设置（config-cli.ts 改的那些）在某个常量里，改了要重启。

import {
  configClear,
  configFlag,
  configNumber,
  configOverride,
  configPendingRestart,
  configSnapshot,
  configStartup,
  configString,
  markHotSetting,
  reloadConfig,
  type Setting,
} from "../config.ts";
import { parseBool } from "../env.ts";
import { listConfig } from "../store.ts";
import { pruneUsage } from "../usage.ts";

// The retention is read whenever the usage log is pruned, and the panel
// changes it without a restart: it is hot, so the panel does not keep saying
// "pending restart" about a setting that is already in force.
markHotSetting("USAGE_RETENTION_DAYS");

// Ask for it right here, so the panel knows this setting exists even in a
// process that never prunes the usage log itself.
configNumber("USAGE_RETENTION_DAYS", 30);

// The other two the panel can change: they are read on every request by other
// modules, but the panel's list is built from the snapshot — a setting nobody
// asked for is not in the snapshot, so it would not be on the panel and
// config-cli would refuse to write it. So ask for them here too: the three
// are treated the same way.
configFlag("REQUIRE_API_KEY", false);
configString("ADMIN_CORS_ORIGINS", "");

/** 一个配置项在面板里的样子。 */
export interface ConfigItemView {
  key: string;
  /** 给人看的短名字：「Qoder 中国区」。 */
  label: string;
  value: string;
  /** database / environment / default */
  source: string;
  fallback: string;
  group: string;
  description: string;
  secret: boolean;
  /** 敏感项现在有没有值。 */
  hasValue: boolean;
}

/**
 * 每个设置是干什么的。面板上就靠这一句话。
 *
 * 只有面板能改的那几个留在这里：服务内部的设置（上游的地址、轮询与预警的
 * 窗口、模拟客户端用的请求标识）改了也没有人读，露出来只会让人改出坏状态。
 */
const DESCRIPTIONS: Record<string, string> = {
  ADMIN_CORS_ORIGINS: "允许跨域访问管理接口的来源，逗号分隔。空表示不允许（面板和网关同源）",
  REQUIRE_API_KEY: "开启后，调用网关的 agent 必须带 API KEY；关闭则任何请求都放行",
  USAGE_RETENTION_DAYS: "用量记录保留多少天",
  QODER_LEGACY_ATTEMPTS: "Qoder 老协议最多试几次",
};

/**
 * 每个设置的短名字。
 *
 * 面板上给的是这个，不是 env 的键名 —— 键名是给机器看的，给人的是
 * 「Qoder 中国区」这种。
 */
const LABELS: Record<string, string> = {
  ADMIN_CORS_ORIGINS: "允许的跨域来源",
  REQUIRE_API_KEY: "是否开启 API KEY 验证",
  USAGE_RETENTION_DAYS: "用量保留天数",
  QODER_LEGACY_ATTEMPTS: "Qoder 老协议重试次数",
};

/** 值的结尾像密钥的，就不给人看。 */
const SECRET_SUFFIXES = ["_KEY", "_PASSWORD", "_SECRET", "_TOKEN"];

/** 这些键不是密钥，是开关或者数字。名字撞上了后缀而已。 */
const NOT_SECRET = new Set(["REQUIRE_API_KEY"]);

/**
 * 面板上能改的设置。
 *
 * 大部分设置是服务内部的事：上游的地址、轮询与预警的窗口、模拟客户端用的
 * 请求标识。这些改了也没用（env 覆盖了照样按代码走），而且露出来只会让人
 * 改出坏状态 —— 所以不公布。
 *
 * 面板只看到这 handful 个：网关自己的两三个。
 *
 * 上游的开关**不在这里**：上游那一页有开关，在这儿再放一份是重复的，而且
 * 两份会打架。
 */
const USER_FACING = new Set([
  // 网关自己
  "REQUIRE_API_KEY",
  "ADMIN_CORS_ORIGINS",
  // 用量记录留多久
  "USAGE_RETENTION_DAYS",
]);

/** 这个设置是不是敏感值。 */
function isSecret(key: string): boolean {
  if (NOT_SECRET.has(key)) return false;
  return SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * 一个设置的短名字。
 *
 * 表里有就用表里的；没有就拿说明的第一句 —— 键名不给人看。
 */
function labelOf(key: string, description: string): string {
  const label = LABELS[key];
  if (label) return label;
  const first = description.split(/[。；\n]/)[0]?.trim();
  return first || "未命名的设置";
}

/**
 * 所有配置项。
 *
 * 值取数据库里的覆盖值（面板刚写的那份），没有就取进程启动时读的那份；
 * 来源跟着值走。
 */
export function configItems(): ConfigItemView[] {
  const overrides = new Map(listConfig().map((row) => [row.key, row.value]));
  return configSnapshot()
    .filter((setting) => USER_FACING.has(setting.key))
    .map((setting) => {
    const override = overrides.get(setting.key);
    const atStart = configStartup(setting.key);
    const raw = override ?? atStart?.raw ?? String(setting.fallback);
    const source = override !== undefined ? "database" : atStart?.source ?? "default";
    const secret = isSecret(setting.key);
    // 敏感项只写不读：值不回给面板，掩码长得像值，容易被当成真值存回去。
    // 「有没有值」单独用 hasValue 说。
    const hasValue = override !== undefined ? override.length > 0 : raw.length > 0;
    const description = DESCRIPTIONS[setting.key] ?? "";
    return {
      key: setting.key,
      label: labelOf(setting.key, description),
      value: secret ? "" : effectiveValue(setting, raw),
      source,
      fallback: String(setting.fallback),
      group: setting.group,
      description,
      secret,
      hasValue,
    };
    });
}

/**
 * The value the service actually uses, not the string that was written.
 *
 * A boolean setting is parsed when the service reads it, and a string it
 * cannot parse falls back to the default. Showing the raw string would make
 * the panel and the gateway disagree about the same setting: the panel says
 * 「开启」, the gateway runs with the default. So the panel is told what is in
 * effect.
 */
function effectiveValue(setting: Setting, raw: string): string {
  if (setting.type !== "boolean") return raw;
  const parsed = parseBool(raw);
  return parsed === null ? String(setting.fallback) : String(parsed);
}

/**
 * 面板能改的键。
 *
 * 只有 USER_FACING 里那些。服务内部的设置不公布，也不许面板改 —— 改了
 * 也没用（env 覆盖了照样按代码走），改了只会改出坏状态。
 *
 * 运维要改内部的设置，走 config-cli.ts（那是给这台机器的人用的）。
 */
export function knownConfigKeys(): Set<string> {
  return new Set([...USER_FACING].filter((key) => configSnapshot().some((s) => s.key === key)));
}

/**
 * 改一个设置。
 *
 * 清掉就是回到环境变量或代码里的默认值。改完不热生效，要重启。
 *
 * 面板能改的那几个是热的（下一个请求就是新的值）✓ —— 用量保留天数就是其中
 * 一个：改完立刻按新的天数清一遍。
 */
export function setConfigValue(key: string, value: string, clear = false): { ok: boolean; message: string } {
  if (!knownConfigKeys().has(key)) {
    return { ok: false, message: `不认识的配置项：${key}` };
  }
  if (clear) {
    configClear(key);
    reloadConfig();
    return { ok: true, message: `清掉了 ${key} 的覆盖值` };
  }
  configOverride(key, value);
  // 改完就重新读一遍：面板能改的那些是热的，下一个请求就是新的值。
  reloadConfig();
  // 保留天数改了：按新的天数清一遍，不用等下一个小时。
  if (key === "USAGE_RETENTION_DAYS") {
    const days = configNumber("USAGE_RETENTION_DAYS", 30);
    const dropped = pruneUsage(days);
    if (dropped > 0) console.log(`  [USAGE] 丢掉了 ${dropped} 条超过 ${days} 天的用量记录`);
  }
  return { ok: true, message: `写了 ${key}` };
}

/**
 * 是不是有改了还没重启的东西。
 *
 * 面板能改的设置是热的：改完就生效，所以它们不算。服务自己内部的设置
 * （config-cli.ts 改的那些）在某个常量里，要重启。
 */
export function pendingRestart(): boolean {
  return configPendingRestart();
}
