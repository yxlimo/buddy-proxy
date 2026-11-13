/**
 * 管理接口失败的机器码 → 面板文案。
 *
 * 后端失败时抛 Connect 错误：错误消息里放排查用的事实（哪个 id、上游原文），
 * 机器码放在响应头 `buddy-error` 上。给人看的那句话在面板这一侧，按码查表，
 * 同一件事不会在两侧各写一份中文。
 *
 * 文案只讲哪里错了：一句话，陈述事实，不给操作建议（不写「请」「填一个」
 * 「换一个」「刷新页面」「稍后重试」这类话）。理由是正常的错在面板上已经
 * 被提前挡住、根本点不出来，剩下的都是少见情况，指引只会变成废话。
 *
 * 其余规矩：不复述字段名，不提实现，不写设计取舍；每条不超过 20 汉字。
 * 一个码一句话，两句一样就说明两个码分不清原因。
 */

/** 机器码所在的响应头。拼写固定小写（取值时大小写不敏感，键名统一写小写）。 */
export const BUDDY_ERROR_HEADER = 'buddy-error'

/**
 * 码表。键是后端 `lib/admin/error-codes.ts` 里的机器码，值是面板文案。
 *
 * 查表一律走 `adminErrorText`，不要直接下标取：`TABLE['constructor']` 会取到
 * 原型上的东西，看上去像认得这个码。
 */
export const ADMIN_ERROR_TEXT: Readonly<Record<string, string>> = {
  // 平台
  PLATFORM_ID_MISSING: '平台 id 没有填',
  PLATFORM_ID_INVALID: '平台 id 只能用小写字母、数字和连字符',
  PLATFORM_ID_RESERVED: '这个 id 是网关自用的',
  PLATFORM_ID_TAKEN_BY_ACCOUNT: '这个 id 已经是账号名',
  PLATFORM_ID_NOT_PRESET: '模拟客户端的 id 只能是预置里的那几个',
  PLATFORM_ALREADY_EXISTS: '这个平台 id 已经被占用',
  PLATFORM_LABEL_MISSING: '平台名没有填',
  PLATFORM_BASE_URL_MISSING: '地址没有填',
  PLATFORM_BASE_URL_INVALID:
    '地址不是以 http:// 或 https:// 开头的完整网址',
  PLATFORM_KIND_UNKNOWN: '网关没有登记这个类型',
  PLATFORM_KIND_NOT_CREATABLE: '这一类只能由预置创建',
  PLATFORM_KIND_FIXED: '平台类型建好之后不能改',
  PLATFORM_NOT_FOUND: '这个平台不存在',
  PLATFORM_WRITE_FAILED: '写库失败',

  // 额度插件
  QUOTA_PLUGIN_UNKNOWN: '网关没有登记这个额度插件',

  // 账号
  ACCOUNT_PLATFORM_NOT_FOUND: '这个平台不存在',
  ACCOUNT_NOT_FOUND: '这个账号不存在',
  ACCOUNT_KEY_COUNT_SHORT: '凭据段数不够，缺少的几段会被清空',
  ACCOUNT_TAKES_NO_KEY: '这一类账号不收 API key',

  // 公布的模型
  MODEL_NOT_GIVEN: '请求里没有模型',
  MODEL_ID_MISSING: '模型 id 没有填',
  MODEL_ID_DUPLICATE: '有两个模型 id 只差大小写',
  MODEL_HAS_NO_TARGET: '这个模型没有上游目标',
  MODEL_MISSING_UPSTREAM: '上游模型 id 没有填',
  MODEL_DUPLICATE_TARGET: '同一平台上同一个上游模型有两行',
  MODEL_NUMBER_INVALID: '上下文长度或输出上限不是整数',
  MODEL_NUMBER_OUT_OF_RANGE: '上下文长度或输出上限超出范围',
  MODEL_CREDITS_INVALID: '倍率是负数',
  MODEL_BILLING_INVALID: '计费方式、币种或单价不对',

  // 人工模型元数据
  MODEL_OVERRIDE_LIST_INVALID: '自定义模型不是列表',
  MODEL_OVERRIDE_ENTRY_INVALID: '自定义模型有一条格式不对',
  MODEL_OVERRIDE_WRITE_FAILED: '写自定义模型失败',
  MODEL_OVERRIDE_NOT_FOUND: '这条自定义模型不存在',
}

/**
 * 没有这条码的文案（后端加了码、面板还没跟上）。
 *
 * 直接给机器码：这时候任何中文包装都只会把码埋进一句话里，反而更难搜、
 * 更难贴去查。缺哪条码由 `describeError` 的 console.warn 报给开发。
 */
export function unknownAdminErrorText(code: string): string {
  return code
}

/**
 * 按机器码取文案。认不得的码返回 `undefined`。
 *
 * 用自有属性判断：`constructor`、`toString` 这类原型键不是码，不能命中。
 */
export function adminErrorText(code: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ADMIN_ERROR_TEXT, code)) {
    return undefined
  }
  return ADMIN_ERROR_TEXT[code]
}
