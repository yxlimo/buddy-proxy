// lib/admin/config.ts — 配置项的说明，以及面板改配置的那条路。
//
// 设置有三个来源：数据库（面板写的）、环境（部署写的）、代码里的默认值。
// 面板看到的是这三个来源合成之后的样子，并且要标出每个值是从哪来的 ——
// 不然改了 env 也不知道到底谁说了算。
//
// 面板能改的设置有两种生效方式：热的那几个（写进数据库之后重新读一遍，下一个请求
// 就是新的值），以及读一次就定在常量里的那些（面板改得动，但要重启）。面板会自己
// 说清是哪种（configPendingRestart）。
// 服务自己内部的设置（config-cli.ts 改的那些）只有重启这一条路。

import {
  configClear,
  configFlag,
  configNumber,
  configOverride,
  configPendingRestart,
  configSnapshot,
  configString,
  markHotSetting,
  reloadConfig,
  type Setting,
} from "../config.ts";
import { parseBool, readEnvValue } from "../env.ts";
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

// 三个超时旋钮。它们是热的：deliver.ts 与 policy.ts 在每条请求开始时各读一次，
// 所以面板改完不用重启。这里显式问一次，是为了让一个还没发过任何请求的进程
// （面板、config-cli）也知道这三个设置存在 —— 没问过的设置不在快照里。
//
// 默认值必须与路由里那份一致：lib/router/deliver.ts 的 STREAM_FIRST_FRAME_DEFAULT_MS
// 与 STREAM_IDLE_DEFAULT_MS、lib/router/upstreams/policy.ts 的
// ATTEMPT_BUDGET_DEFAULT_MS。第一个问的人定的默认值就是生效的那个，所以两边
// 一旦飘了，改的是默认值本身；test/admin-config-check.ts 盯着这一致性。
configNumber("ROUTER_FIRST_FRAME_MS", 300_000);
configNumber("ROUTER_STREAM_IDLE_MS", 180_000);
configNumber("ROUTER_RETRY_BUDGET_MS", 180_000);

// 剩下这几个是「读一次就定在常量里」的（lib/periodic.ts 的定时器、
// lib/admin/upstreams.ts 的快照过期时间、lib/admin/benefits.ts 的间隔、
// lib/router/handle.ts 的排队重试）：面板改得动，但要重启才生效。同样在这里显式
// 问一次，理由与上面那三条一样。
configFlag("PERIODIC_ENABLED", true);
configNumber("HEALTH_CACHE_MS", 300_000);
configFlag("BENEFITS_DISABLED", false);
configNumber("BENEFITS_INTERVAL_MS", 3_600_000);
configNumber("QODER_LEGACY_RETRY_MS", 10_000);
// 排队时跳过那一次等待：默认关（维持线上现在的行为）。热设置 ——
// lib/router/upstreams/qoder.ts 每次调用都读一次。
configFlag("QODER_SKIP_QUEUE_WAIT", false);

// 签到开关是这一组里唯一一个热的：它是在 benefitUpstreams() 里按调用读的，而那个
// 函数每一次跑腿（lib/router/benefits.ts 的 runOnce）与每一次 /health 都会问一次，
// 所以面板改完不用重启。它的标记只能写在这里：读它的那个模块不是设置的登记处。
markHotSetting("BENEFITS_DISABLED");

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
  /**
   * 面板写进数据库的那份值。
   *
   * 环境变量在用的时候，生效的是环境变量的值，这份在库里等：环境变量撤了
   * 才轮到它。敏感项不给。
   */
  overrideValue: string;
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
  ROUTER_FIRST_FRAME_MS: "等上游第一个字最多多久（毫秒）。调小会砍掉正常的慢答复",
  ROUTER_STREAM_IDLE_MS: "流开始后停顿多久算断（毫秒）。调小会砍掉正在思考的答复",
  ROUTER_RETRY_BUDGET_MS: "一次请求的重试总时限（毫秒）。调小会让上游抽一下就直接报错",
  PERIODIC_ENABLED: "后台定时任务总开关。关闭后不换令牌、不签到、不扫余额",
  HEALTH_CACHE_MS: "额度与状态快照多久刷新一次（毫秒）",
  BENEFITS_DISABLED: "关闭每日签到与领奖。关闭后积分不会自动到账",
  BENEFITS_INTERVAL_MS: "签到任务多久跑一次（毫秒）。调大后奖励到账变慢",
  QODER_LEGACY_RETRY_MS: "Qoder 旧协议排队后隔多久重试（毫秒）",
  QODER_SKIP_QUEUE_WAIT: "开着时排队不等待，直接交给下一个目标。关着时先等一次再放弃",
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
  ROUTER_FIRST_FRAME_MS: "等首帧时限",
  ROUTER_STREAM_IDLE_MS: "流空闲上限",
  ROUTER_RETRY_BUDGET_MS: "重试总时限",
  PERIODIC_ENABLED: "后台定时任务",
  HEALTH_CACHE_MS: "快照刷新间隔",
  BENEFITS_DISABLED: "关闭签到与领奖",
  BENEFITS_INTERVAL_MS: "签到间隔",
  QODER_LEGACY_RETRY_MS: "排队重试间隔",
  QODER_SKIP_QUEUE_WAIT: "排队时不等待",
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
 * 面板只看到这十一个：网关自己的、用量保留、三个超时旋钮、定时任务与额度快照、
 * 签到、Qoder 的排队重试。
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
  // 三个超时旋钮：等首帧、流中途的停顿、重试的总时限
  "ROUTER_FIRST_FRAME_MS",
  "ROUTER_STREAM_IDLE_MS",
  "ROUTER_RETRY_BUDGET_MS",
  // 后台的定时任务与它刷的那份快照
  "PERIODIC_ENABLED",
  "HEALTH_CACHE_MS",
  // 签到
  "BENEFITS_DISABLED",
  "BENEFITS_INTERVAL_MS",
  // Qoder 旧协议排队时的重试间隔
  "QODER_LEGACY_RETRY_MS",
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
 * 值是**现在生效**的那份：环境变量先（部署钉住的说了算），库里的覆盖其次，
 * 代码里的默认值最后。面板刚写的那份如果被环境变量挡着，就另外放在
 * overrideValue 里 —— 它没丢，在等环境变量撤了才轮到它。
 */
export function configItems(): ConfigItemView[] {
  const overrides = new Map(listConfig().map((row) => [row.key, row.value]));
  return configSnapshot()
    .filter((setting) => USER_FACING.has(setting.key))
    .map((setting) => {
    const override = overrides.get(setting.key);
    // 生效的值：快照里就是模块读的时候定下的那份。
    const raw = String(setting.value);
    const source = setting.source;
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
      // 面板写进库的那份。环境变量在用的时候，它在等。
      overrideValue: secret ? "" : (override ?? ""),
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
 * 清掉就是回到环境变量或代码里的默认值。热的那几个改完下一个请求就是新的值；
 * 其余的要重启，面板照 configPendingRestart 说。
 *
 * 用量保留天数是热的，所以改完立刻按新的天数清一遍。
 */
export function setConfigValue(key: string, value: string, clear = false): { ok: boolean; message: string } {
  if (!knownConfigKeys().has(key)) {
    return { ok: false, message: `无法识别的配置项：${key}` };
  }
  if (clear) {
    configClear(key);
    reloadConfig();
    return { ok: true, message: `已清除 ${key} 的覆盖值` };
  }
  configOverride(key, value);
  // 改完就重新读一遍：面板能改的那些是热的，下一个请求就是新的值。
  reloadConfig();
  // 环境变量钉着的设置：面板写的这份在库里等着，但生效的还是环境变量那个。
  // 说清楚，不然用户看着值没变，会以为没保存成功。
  if (readEnvValue(key) !== null) {
    return {
      ok: true,
      message: `已保存 ${key}，但这个设置被环境变量固定，当前生效的仍是环境变量的值；环境变量撤销后才会使用这一份。`,
    };
  }
  // 保留天数改了：按新的天数清一遍，不用等下一个小时。
  if (key === "USAGE_RETENTION_DAYS") {
    const days = configNumber("USAGE_RETENTION_DAYS", 30);
    const dropped = pruneUsage(days);
    if (dropped > 0) console.log(`  [USAGE] 丢掉了 ${dropped} 条超过 ${days} 天的用量记录`);
  }
  return { ok: true, message: `已保存 ${key}` };
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
