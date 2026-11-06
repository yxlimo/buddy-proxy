/**
 * 新增/修改平台时能提前挡下的那几件错。
 *
 * 服务端那套校验（`lib/open-platforms.ts` 的 checkId / checkBaseUrl / 名字）
 * 是兜底：别的客户端、并发、旧面板都会碰到。面板这一层的判据要做到「正常点
 * 击点不出错」—— 用户填的时候就把话说清，保存按钮灰着，请求根本不发。
 *
 * 判据只用面板手头有的东西：平台列表（id 与账号 id）、填的那几格。没有一项
 * 是猜的；猜不出来的一律不拦，让服务端说。
 */

/** 网关自己用的路径段：平台 id 不能是这些（与 lib/open-platforms.ts 的 RESERVED_IDS 一份）。 */
const RESERVED_IDS = ['v1', 'admin', 'health', 'healthz', 'metrics']

/** 平台 id 的字面：小写字母与数字开头，后面是它们与连字符（与 lib/open-platforms.ts 同一份）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/

/** 哪一格有问题。跟界面上的格子一一对应。 */
export type PlatformField = 'id' | 'label' | 'baseUrl'

/** 一格一条：问题就一句话。 */
export type PlatformProblems = Partial<Record<PlatformField, string>>

/** 三格「没填」的那句话：行内提示与页脚那份「还差什么」取同一份。 */
export const MISSING_TEXT: Readonly<Record<PlatformField, string>> = {
  id: '平台 id 没有填',
  label: '平台名没有填',
  baseUrl: '地址没有填',
}

/**
 * 这一格填的 id 有什么不对。没填、格式、网关自用、账号名、已被占用，各一句。
 *
 * `takenIds` 是表里现有的平台 id（改平台时不把自己算进来），`accountIds` 是
 * 全部账号 id：两边的命名空间是同一个，撞了面板分不清查的是谁。
 */
export function platformIdProblem(input: {
  id: string
  takenIds: readonly string[]
  accountIds: readonly string[]
}): string | null {
  const id = input.id.trim()
  if (!id) return MISSING_TEXT.id
  if (!ID_PATTERN.test(id)) return '平台 id 只能用小写字母、数字和连字符'
  if (RESERVED_IDS.includes(id)) return '这个 id 是网关自用的'
  if (input.accountIds.includes(id)) return '这个 id 已经是账号名'
  if (input.takenIds.includes(id)) return '这个平台 id 已经被占用'
  return null
}

/**
 * 地址那一格有什么不对。
 *
 * 判法就是「能不能当一个网址解析」加上「协议是不是 http(s)、有没有主机」——
 * 与网关那一侧同一个意思。这里只判、不改写：用户填的地址原样保存，面板不替
 * 他补斜杠、也不替他改路径。
 */
export function baseUrlProblem(value: string): string | null {
  const baseUrl = value.trim()
  if (!baseUrl) return MISSING_TEXT.baseUrl
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return '地址不是以 http:// 或 https:// 开头的完整网址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '地址不是以 http:// 或 https:// 开头的完整网址'
  }
  if (!url.hostname) return '地址不是以 http:// 或 https:// 开头的完整网址'
  return null
}

/**
 * 这一份草稿提交前有什么不对。
 *
 * 只判界面上此刻摆着的那几格：`undefined` 表示这一格不摆（不判），空串表示
 * 摆了但没填（要报）。模拟客户端的 id 由预置定、地址归代码，那两格不摆；
 * 改平台时 id 改不了，也不判。
 */
export function platformProblems(input: {
  /** 平台 id：改平台时 id 改不了，传 undefined 跳过这一格。 */
  id?: string
  label: string
  /** 地址：模拟客户端的地址归代码，传 undefined 跳过这一格。 */
  baseUrl?: string
  takenIds: readonly string[]
  accountIds: readonly string[]
}): PlatformProblems {
  const problems: PlatformProblems = {}
  if (input.id !== undefined) {
    const id = platformIdProblem({
      id: input.id,
      takenIds: input.takenIds,
      accountIds: input.accountIds,
    })
    if (id) problems.id = id
  }
  if (!input.label.trim()) problems.label = MISSING_TEXT.label
  if (input.baseUrl !== undefined) {
    const baseUrl = baseUrlProblem(input.baseUrl)
    if (baseUrl) problems.baseUrl = baseUrl
  }
  return problems
}
