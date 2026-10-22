// lib/admin/config.ts — 配置项的说明，以及面板改配置的那条路。
//
// 设置有三个来源：数据库（面板写的）、环境（部署写的）、代码里的默认值。
// 面板看到的是这三个来源合成之后的样子，并且要标出每个值是从哪来的 ——
// 不然改了 env 也不知道到底谁说了算。
//
// 改了不热生效：数据库里的值要重启才被进程读走。所以写完只标「待重启」。

import { configClear, configOverride, configPendingRestart, configSnapshot, configStartup } from "../config.ts";
import { listConfig } from "../store.ts";

/** 一个配置项在面板里的样子。 */
export interface ConfigItemView {
  key: string;
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

/** 值的结尾像密钥的，就不给人看。 */
const SECRET_SUFFIXES = ["_KEY", "_PASSWORD", "_SECRET", "_TOKEN"];

/** 这个设置是不是敏感值。 */
function isSecret(key: string): boolean {
  return SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * 所有配置项。
 *
 * 值取数据库里的覆盖值（面板刚写的那份），没有就取进程启动时读的那份；
 * 来源跟着值走。
 */
export function configItems(): ConfigItemView[] {
  const overrides = new Map(listConfig().map((row) => [row.key, row.value]));
  return configSnapshot().map((setting) => {
    const override = overrides.get(setting.key);
    const atStart = configStartup(setting.key);
    const raw = override ?? atStart?.raw ?? String(setting.fallback);
    const source = override !== undefined ? "database" : atStart?.source ?? "default";
    const secret = isSecret(setting.key);
    // 敏感项只写不读：值不回给面板，掩码长得像值，容易被当成真值存回去。
    // 「有没有值」单独用 hasValue 说。
    const hasValue = override !== undefined ? override.length > 0 : raw.length > 0;
    return {
      key: setting.key,
      value: secret ? "" : raw,
      source,
      fallback: String(setting.fallback),
      group: setting.group,
      description: DESCRIPTIONS[setting.key] ?? "",
      secret,
      hasValue,
    };
  });
}

/** 面板能改的键：进程问过的那些。 */
export function knownConfigKeys(): Set<string> {
  return new Set(configSnapshot().map((s) => s.key));
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
    return { ok: true, message: `清掉了 ${key} 的覆盖值` };
  }
  configOverride(key, value);
  return { ok: true, message: `写了 ${key}` };
}

/** 是不是有改了还没重启的东西。 */
export function pendingRestart(): boolean {
  return configPendingRestart();
}
