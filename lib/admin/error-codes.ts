// lib/admin/error-codes.ts — 管理接口失败的机器码。
//
// 失败的表达只有一种：一次 Connect 错误。错误消息（第一个参数）放排查用的
// 事实（哪个 id、上游原文），**不是**给用户读的文案 —— 文案在面板那一侧，
// 按这里的机器码查表，同一件事不会在两侧各写一份中文。
//
// 机器码走响应头 buddy-error（小写，固定这个拼写）。它稳定、可枚举，面板
// 见码认事；新增一个码就是给面板加一条文案。
//
// 一个码一个状态码，写在同一张表里：同一个问题从不同方法上冒出来时，状态码
// 不该跟着变。表里没有的那些（真的意外）落到 Connect 的 Internal，那时没有
// buddy-error 这个头，面板按「内部错误」兜底。

import { Code, ConnectError } from "@connectrpc/connect";

/** 机器码所在的响应头。拼写固定小写，各处都用这个常量，不手写字符串。 */
export const ADMIN_ERROR_HEADER = "buddy-error";

/* ------------------------------------------------------------------ *
 * 平台
 * ------------------------------------------------------------------ */

/** 加平台时没给 id。 */
export const PLATFORM_ID_MISSING = "PLATFORM_ID_MISSING";
/** 平台 id 不符合 [a-z0-9][a-z0-9-]{0,30}。 */
export const PLATFORM_ID_INVALID = "PLATFORM_ID_INVALID";
/** 这个 id 网关自己用（路径里那一段）。 */
export const PLATFORM_ID_RESERVED = "PLATFORM_ID_RESERVED";
/** 这个 id 已经被一个账号占了（两个命名空间看起来一样，面板分不清）。 */
export const PLATFORM_ID_TAKEN_BY_ACCOUNT = "PLATFORM_ID_TAKEN_BY_ACCOUNT";
/** 模拟客户端的 id 只能是预置目录里的那几个。 */
export const PLATFORM_ID_NOT_PRESET = "PLATFORM_ID_NOT_PRESET";
/** 同名同 id 的平台已经有了（含别的进程刚建好的那一种）。 */
export const PLATFORM_ALREADY_EXISTS = "PLATFORM_ALREADY_EXISTS";
export const PLATFORM_LABEL_MISSING = "PLATFORM_LABEL_MISSING";
export const PLATFORM_BASE_URL_MISSING = "PLATFORM_BASE_URL_MISSING";
/** 地址不是完整的 http/https 网址。 */
export const PLATFORM_BASE_URL_INVALID = "PLATFORM_BASE_URL_INVALID";
/** 这一类适配器没登记（写进去这个平台就接不了任何请求）。 */
export const PLATFORM_KIND_UNKNOWN = "PLATFORM_KIND_UNKNOWN";
/** 这一类只能由预置创建，面板不给新建。 */
export const PLATFORM_KIND_NOT_CREATABLE = "PLATFORM_KIND_NOT_CREATABLE";
/** 类型建完就定下，改不了（换类型要删了重建）。 */
export const PLATFORM_KIND_FIXED = "PLATFORM_KIND_FIXED";
/** 模拟客户端的模型目录由代码提供：请求里要改 models / models_auto 就拒。 */
export const PLATFORM_MODELS_FIXED = "PLATFORM_MODELS_FIXED";
export const PLATFORM_NOT_FOUND = "PLATFORM_NOT_FOUND";
/** 写库失败，且不是重名（重名有自己的码）。 */
export const PLATFORM_WRITE_FAILED = "PLATFORM_WRITE_FAILED";

/* ------------------------------------------------------------------ *
 * 额度插件
 * ------------------------------------------------------------------ */

/** 这个插件 id 没人登记（存下去平台就再也不会有一条额度结论）。 */
export const QUOTA_PLUGIN_UNKNOWN = "QUOTA_PLUGIN_UNKNOWN";

/* ------------------------------------------------------------------ *
 * 账号
 * ------------------------------------------------------------------ */

/** AddAccount 指的平台不存在。 */
export const ACCOUNT_PLATFORM_NOT_FOUND = "ACCOUNT_PLATFORM_NOT_FOUND";
export const ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND";
/** 发来的凭据段数不够：按位置写下去会静默清掉缺的那几段。 */
export const ACCOUNT_KEY_COUNT_SHORT = "ACCOUNT_KEY_COUNT_SHORT";
/** 这一类的账号不收 API Key（MiniMax Code 只用登录会话）。 */
export const ACCOUNT_TAKES_NO_KEY = "ACCOUNT_TAKES_NO_KEY";

/* ------------------------------------------------------------------ *
 * 公布的模型
 * ------------------------------------------------------------------ */

/** 请求里没有 model 这一格。 */
export const MODEL_NOT_GIVEN = "MODEL_NOT_GIVEN";
/** 模型（或人工条目的模型 id）空着。 */
export const MODEL_ID_MISSING = "MODEL_ID_MISSING";
/** 同一次请求里两条只差大小写的 id 说的是同一个模型。 */
export const MODEL_ID_DUPLICATE = "MODEL_ID_DUPLICATE";
/** 一个目标都没有：这样的模型谁都不接。 */
export const MODEL_HAS_NO_TARGET = "MODEL_HAS_NO_TARGET";
/** 目标里没填上游模型 id。 */
export const MODEL_MISSING_UPSTREAM = "MODEL_MISSING_UPSTREAM";
/** 上下文长度 / 输出上限不是整数。 */
export const MODEL_NUMBER_INVALID = "MODEL_NUMBER_INVALID";
/** 上下文长度 / 输出上限是负数或超过 int32。 */
export const MODEL_NUMBER_OUT_OF_RANGE = "MODEL_NUMBER_OUT_OF_RANGE";
/** 倍率不是非负数（负的价钱没有意义）。 */
export const MODEL_CREDITS_INVALID = "MODEL_CREDITS_INVALID";

/* ------------------------------------------------------------------ *
 * 人工模型元数据
 * ------------------------------------------------------------------ */

export const MODEL_OVERRIDE_LIST_INVALID = "MODEL_OVERRIDE_LIST_INVALID";
/** 一条条目不是对象。 */
export const MODEL_OVERRIDE_ENTRY_INVALID = "MODEL_OVERRIDE_ENTRY_INVALID";
export const MODEL_OVERRIDE_WRITE_FAILED = "MODEL_OVERRIDE_WRITE_FAILED";
/** 要删的那条本来就没有（静默成功会让人以为删掉了）。 */
export const MODEL_OVERRIDE_NOT_FOUND = "MODEL_OVERRIDE_NOT_FOUND";

/**
 * 全部机器码，以及它们各自的状态码。
 *
 * 命名一律「对象_问题」：对象是平台 / 账号 / 模型 / 人工条目 / 额度插件。
 * 状态码按语义选，不一律 Internal：
 *
 *   InvalidArgument     参数本身不对（空、格式、字段缺失、数值越界）
 *   NotFound            被指的东西不存在
 *   AlreadyExists       冲突（同名同 id 已经有了）
 *   FailedPrecondition  前置条件不满足（这一类不收这个、平台没有可用账号……）
 *   Internal            其余意外
 */
export const ADMIN_ERRORS = {
  [PLATFORM_ID_MISSING]: Code.InvalidArgument,
  [PLATFORM_ID_INVALID]: Code.InvalidArgument,
  [PLATFORM_ID_RESERVED]: Code.InvalidArgument,
  [PLATFORM_ID_TAKEN_BY_ACCOUNT]: Code.AlreadyExists,
  [PLATFORM_ID_NOT_PRESET]: Code.InvalidArgument,
  [PLATFORM_ALREADY_EXISTS]: Code.AlreadyExists,
  [PLATFORM_LABEL_MISSING]: Code.InvalidArgument,
  [PLATFORM_BASE_URL_MISSING]: Code.InvalidArgument,
  [PLATFORM_BASE_URL_INVALID]: Code.InvalidArgument,
  [PLATFORM_KIND_UNKNOWN]: Code.InvalidArgument,
  [PLATFORM_KIND_NOT_CREATABLE]: Code.FailedPrecondition,
  [PLATFORM_KIND_FIXED]: Code.FailedPrecondition,
  [PLATFORM_MODELS_FIXED]: Code.FailedPrecondition,
  [PLATFORM_NOT_FOUND]: Code.NotFound,
  [PLATFORM_WRITE_FAILED]: Code.Internal,

  [QUOTA_PLUGIN_UNKNOWN]: Code.InvalidArgument,

  [ACCOUNT_PLATFORM_NOT_FOUND]: Code.NotFound,
  [ACCOUNT_NOT_FOUND]: Code.NotFound,
  [ACCOUNT_KEY_COUNT_SHORT]: Code.FailedPrecondition,
  [ACCOUNT_TAKES_NO_KEY]: Code.FailedPrecondition,

  [MODEL_NOT_GIVEN]: Code.InvalidArgument,
  [MODEL_ID_MISSING]: Code.InvalidArgument,
  [MODEL_ID_DUPLICATE]: Code.InvalidArgument,
  [MODEL_HAS_NO_TARGET]: Code.InvalidArgument,
  [MODEL_MISSING_UPSTREAM]: Code.InvalidArgument,
  [MODEL_NUMBER_INVALID]: Code.InvalidArgument,
  [MODEL_NUMBER_OUT_OF_RANGE]: Code.InvalidArgument,
  [MODEL_CREDITS_INVALID]: Code.InvalidArgument,

  [MODEL_OVERRIDE_LIST_INVALID]: Code.InvalidArgument,
  [MODEL_OVERRIDE_ENTRY_INVALID]: Code.InvalidArgument,
  [MODEL_OVERRIDE_WRITE_FAILED]: Code.Internal,
  [MODEL_OVERRIDE_NOT_FOUND]: Code.NotFound,
} as const satisfies Record<string, Code>;

/** 一个机器码。 */
export type AdminErrorCode = keyof typeof ADMIN_ERRORS;

/** 一次失败：机器码 + 排查用的事实。 */
export interface AdminFailure {
  ok: false;
  code: AdminErrorCode;
  /** 排查用的事实（英文，带 id / 字段名 / 上游原文）。不是面板文案。 */
  message: string;
}

/** 一次成功：一句写进日志的回执。 */
export interface AdminSuccess {
  ok: true;
  message: string;
}

/** 一次写入的结论。 */
export type AdminResult = AdminSuccess | AdminFailure;

/**
 * 造一条要抛的错误：状态码照表，机器码进响应头。
 *
 * 只在这里拼 metadata：别处手写 `{ "buddy-error": ... }` 迟早会拼错大小写，
 * 而拼错的那个码面板不认识。
 */
export function adminError(code: AdminErrorCode, detail: string): ConnectError {
  return new ConnectError(detail || code, ADMIN_ERRORS[code], { [ADMIN_ERROR_HEADER]: code });
}
