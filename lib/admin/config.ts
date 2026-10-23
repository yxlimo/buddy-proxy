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
  configOverride,
  configPendingRestart,
  configSnapshot,
  configStartup,
  reloadConfig,
} from "../config.ts";
import { listConfig } from "../store.ts";

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

/** 每个设置是干什么的。面板上就靠这一句话。 */
const DESCRIPTIONS: Record<string, string> = {
  ADMIN_CORS_ORIGINS: "允许跨域访问管理接口的来源，逗号分隔。空表示不允许（面板和网关同源）",
  // MiniMax
  MINIMAX_CODE: "MiniMax Code 上游的开关",
  MINIMAX_REGION: "MiniMax 的区域（cn / en）",
  MINIMAX_API_BASE: "MiniMax 的接口地址（留空就按区域选）",
  MINIMAX_AUTH_MODE: "凭据从哪来：oauth 用网关自己的会话，file 只读桌面端的 store",
  MINIMAX_OAUTH_ORIGIN: "MiniMax 授权服务的地址",
  MINIMAX_CLIENT_ID: "MiniMax 的 client id",
  MINIMAX_AUDIENCE: "MiniMax 授权的 audience",
  MINIMAX_SCOPES: "MiniMax 授权的 scope（逗号分隔）",
  MINIMAX_USER_AGENT: "请求带的 User-Agent",
  MINIMAX_ANTHROPIC_VERSION: "Anthropic 方言里带的版本号",
  MINIMAX_ATTRIBUTION_HEADERS: "带不带归属标记头",
  MINIMAX_AUTH_CACHE_MS: "凭据缓存多久（毫秒）",
  MINIMAX_AUTH_WARN_MS: "凭据还剩多久算快到期（毫秒）",
  MINIMAX_REFRESH_BUFFER_MS: "离到期多久开始刷新（毫秒）",
  MINIMAX_WATCH_MS: "多久看一眼凭据，好让快到期的进日志（毫秒）",
  MINIMAX_PING_MS: "保活的间隔（毫秒）",
  // Qoder
  QODER_GLOBAL: "Qoder 全球区的开关",
  QODER_CN: "Qoder 中国区的开关",
  QODER_GLOBAL_OPENAPI_BASE: "Qoder 全球区的 OpenAPI 主机",
  QODER_CN_OPENAPI_BASE: "Qoder 中国区的 OpenAPI 主机",
  QODER_GLOBAL_INFER_BASE: "Qoder 全球区的推理主机",
  QODER_CN_INFER_BASE: "Qoder 中国区的推理主机",
  QODER_GLOBAL_LEGACY_BASE: "Qoder 全球区老协议的主机",
  QODER_LOG_ROUTE: "把请求命中的路由写进日志",
  QODER_ACCOUNT_NAME: "登录时选的账号名",
  QODER_USER_TYPE: "账号类型",
  QODER_USER_AGENT: "请求带的 User-Agent",
  QODER_EFFORT_TIERS: "分档的思考档位",
  QODER_MAX_ATTEMPTS: "新协议最多试几次",
  QODER_LEGACY_MAX_ATTEMPTS: "老协议最多试几次",
  QODER_LEGACY_RETRY_MS: "老协议两次之间等多久（毫秒）",
  QODER_AUTH_CACHE_MS: "凭据缓存多久（毫秒）",
  QODER_AUTH_WARN_MS: "凭据还剩多久算快到期（毫秒）",
  QODER_REFRESH_BUFFER_MS: "离到期多久开始刷新（毫秒）",
  QODER_POLL_INTERVAL_MS: "轮询授权结果的间隔（毫秒）",
  QODER_POLL_TIMEOUT_MS: "轮询授权结果最多等多久（毫秒）",
  // WorkBuddy
  WORKBUDDY_CN: "WorkBuddy 中国区的开关",
  WORKBUDDY_CN_BASE: "WorkBuddy 的接口地址",
  WORKBUDDY_CN_ORIGIN: "WorkBuddy 网页控制台的 Origin",
  WORKBUDDY_CHAT_BASE: "聊天接口的地址（留空就用账号自己的域名）",
  WORKBUDDY_VERSION: "桌面端版本号",
  WORKBUDDY_CLI_VERSION: "命令行版本号",
  WORKBUDDY_AUTH_PLATFORM: "授权时带的平台标记",
  WORKBUDDY_CATALOG_TTL_MS: "上游的模型目录信多久（毫秒）",
  WORKBUDDY_AUTH_CACHE_MS: "凭据缓存多久（毫秒）",
  WORKBUDDY_AUTH_WARN_MS: "凭据还剩多久算快到期（毫秒）",
  WORKBUDDY_REFRESH_BUFFER_MS: "离到期多久开始刷新（毫秒）",
  WORKBUDDY_LOGIN_POLL_MS: "轮询登录结果的间隔（毫秒）",
  WORKBUDDY_LOGIN_TIMEOUT_MS: "登录最多等多久（毫秒）",
  // TokenRhythm
  TOKENRHYTHM: "TokenRhythm 的开关",
  TOKENRHYTHM_API_BASE: "TokenRhythm 平台地址",
  TOKENRHYTHM_INFER_BASE: "TokenRhythm 推理地址",
  TOKENRHYTHM_MAX_ATTEMPTS: "最多试几次",
  // 网关自己
  ROUTER_PORT: "网关听哪个端口",
  ROUTER_HOST: "网关听哪个地址",
  HEALTH_CACHE_MS: "/health 的快照放多久（毫秒）",
  REQUIRE_API_KEY: "agent 侧的前门要不要 api key",
  BENEFITS_INTERVAL_MS: "多久签到一次（毫秒）",
  BENEFITS_DISABLED: "把签到整个关掉",
};

/**
 * 每个设置的短名字。
 *
 * 面板上给的是这个，不是 env 的键名 —— 键名是给机器看的，给人的是
 * 「Qoder 中国区」这种。
 */
const LABELS: Record<string, string> = {
  ADMIN_CORS_ORIGINS: "允许的跨域来源",
  // MiniMax
  MINIMAX_CODE: "MiniMax Code 上游",
  MINIMAX_REGION: "MiniMax 区域",
  MINIMAX_API_BASE: "MiniMax 接口地址",
  MINIMAX_AUTH_MODE: "MiniMax 凭据来源",
  MINIMAX_OAUTH_ORIGIN: "MiniMax 授权服务地址",
  MINIMAX_CLIENT_ID: "MiniMax 客户端 ID",
  MINIMAX_AUDIENCE: "MiniMax 授权受众",
  MINIMAX_SCOPES: "MiniMax 授权范围",
  MINIMAX_USER_AGENT: "MiniMax 请求标识",
  MINIMAX_ANTHROPIC_VERSION: "MiniMax Anthropic 版本",
  MINIMAX_ATTRIBUTION_HEADERS: "MiniMax 归属标记头",
  MINIMAX_AUTH_CACHE_MS: "MiniMax 凭据缓存时长",
  MINIMAX_AUTH_WARN_MS: "MiniMax 凭据预警窗口",
  MINIMAX_REFRESH_BUFFER_MS: "MiniMax 提前刷新时长",
  MINIMAX_WATCH_MS: "MiniMax 凭据巡检间隔",
  MINIMAX_PING_MS: "MiniMax 保活间隔",
  MINIMAX_BASE_URL: "MiniMax 上游地址",
  // Qoder
  QODER_GLOBAL: "Qoder 全球区",
  QODER_CN: "Qoder 中国区",
  QODER_GLOBAL_OPENAPI_BASE: "Qoder 全球区 OpenAPI 主机",
  QODER_CN_OPENAPI_BASE: "Qoder 中国区 OpenAPI 主机",
  QODER_GLOBAL_INFER_BASE: "Qoder 全球区推理主机",
  QODER_CN_INFER_BASE: "Qoder 中国区推理主机",
  QODER_GLOBAL_LEGACY_BASE: "Qoder 全球区老协议主机",
  QODER_LOG_ROUTE: "记录命中的路由",
  QODER_ACCOUNT_NAME: "Qoder 登录账号名",
  QODER_USER_TYPE: "Qoder 账号类型",
  QODER_USER_AGENT: "Qoder 请求标识",
  QODER_EFFORT_TIERS: "Qoder 思考档位对应",
  QODER_MAX_ATTEMPTS: "Qoder 重试次数",
  QODER_LEGACY_MAX_ATTEMPTS: "Qoder 老协议重试次数",
  QODER_LEGACY_ATTEMPTS: "Qoder 老协议重试次数",
  QODER_LEGACY_RETRY_MS: "Qoder 老协议重试间隔",
  QODER_AUTH_CACHE_MS: "Qoder 凭据缓存时长",
  QODER_AUTH_WARN_MS: "Qoder 凭据预警窗口",
  QODER_REFRESH_BUFFER_MS: "Qoder 提前刷新时长",
  QODER_POLL_INTERVAL_MS: "Qoder 授权轮询间隔",
  QODER_POLL_TIMEOUT_MS: "Qoder 授权轮询超时",
  // WorkBuddy
  WORKBUDDY_CN: "WorkBuddy 中国区",
  WORKBUDDY_CN_BASE: "WorkBuddy 接口地址",
  WORKBUDDY_CN_ORIGIN: "WorkBuddy 控制台地址",
  WORKBUDDY_CHAT_BASE: "WorkBuddy 聊天接口地址",
  WORKBUDDY_VERSION: "WorkBuddy 桌面端版本",
  WORKBUDDY_CLI_VERSION: "WorkBuddy 命令行版本",
  WORKBUDDY_AUTH_PLATFORM: "WorkBuddy 授权平台标记",
  WORKBUDDY_CATALOG_TTL_MS: "WorkBuddy 目录缓存时长",
  WORKBUDDY_AUTH_CACHE_MS: "WorkBuddy 凭据缓存时长",
  WORKBUDDY_AUTH_WARN_MS: "WorkBuddy 凭据预警窗口",
  WORKBUDDY_REFRESH_BUFFER_MS: "WorkBuddy 提前刷新时长",
  WORKBUDDY_LOGIN_POLL_MS: "WorkBuddy 登录轮询间隔",
  WORKBUDDY_LOGIN_TIMEOUT_MS: "WorkBuddy 登录超时",
  // TokenRhythm
  TOKENRHYTHM: "TokenRhythm 上游",
  TOKENRHYTHM_API_BASE: "TokenRhythm 平台地址",
  TOKENRHYTHM_INFER_BASE: "TokenRhythm 推理地址",
  TOKENRHYTHM_MAX_ATTEMPTS: "TokenRhythm 重试次数",
  // 网关自己
  ROUTER_PORT: "网关端口",
  ROUTER_HOST: "网关监听地址",
  HEALTH_CACHE_MS: "健康检查缓存时长",
  REQUIRE_API_KEY: "前门要 API key",
  BENEFITS_INTERVAL_MS: "签到间隔",
  BENEFITS_DISABLED: "关掉每日签到",
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
      value: secret ? "" : raw,
      source,
      fallback: String(setting.fallback),
      group: setting.group,
      description,
      secret,
      hasValue,
    };
    });
}

/** 面板能改的键：进程问过的那些。 */
/**
 * 面板能改的键。
 *
 * 只有 USER_FACING 里那些。服务内部的设置不公布，也不许面板改 —— 改���
 * 也没用（env 覆盖了照样按代码走），改了只会改出坏状态。
 *
 * 运维要改内部的设置，走 config-cli.ts（那是给这台机器的人用的 ✓）。
 */
export function knownConfigKeys(): Set<string> {
  return new Set([...USER_FACING].filter((key) => configSnapshot().some((s) => s.key === key)));
}

/**
 * 改一个设置。
 *
 * 清掉就是回到环境变量或代码里的默认值。改完不热生效，要重启。
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
