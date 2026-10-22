import { Code, ConnectError } from '@connectrpc/connect'

/**
 * 服务端用「HTTP 200 + ok:false」表达失败（不认识的配置项、上游 id 对不上、
 * 模型没有目标……）。这类失败不是传输层的错误，是业务上的失败。
 *
 * 前端把它翻成异常，这样成功/失败只有一条路：mutateAsync 正常返回就是成功，
 * 抛出来就是失败，页面不用在每个地方各写一遍 if (!result.ok)。
 */
export class ApiFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/**
 * 断言服务端的业务结果。ok 为假时抛出，message 直接给人看。
 */
export function assertOk(
  result: { ok: boolean; message?: string },
  fallback: string
): void {
  if (result.ok) return
  throw new ApiFailure(result.message?.trim() || fallback)
}

/**
 * 把 Connect 的错误翻成人话。
 *
 * 契约里区分的几类失败：凭据过期、上游不可用、配置非法、冲突。面板上
 * 至少要让人知道是自己没填令牌，还是网关自己出问题了。
 */
export function describeError(error: unknown): string {
  // 业务上的失败（ok:false）原样给用户看，别再包一层。
  if (error instanceof ApiFailure) {
    return error.message
  }
  if (error instanceof ConnectError) {
    const detail = error.rawMessage || error.message
    switch (error.code) {
      case Code.Unauthenticated:
        return `鉴权没过：${detail}（令牌填错了，或者还没填）`
      case Code.PermissionDenied:
        return `没有权限：${detail}`
      case Code.NotFound:
        return `找不到：${detail}`
      case Code.InvalidArgument:
        return `参数不合法：${detail}`
      case Code.AlreadyExists:
        return `已经存在：${detail}`
      case Code.Unavailable:
        return `网关连不上：${detail}`
      case Code.DeadlineExceeded:
        return `请求超时：${detail}`
      case Code.Unimplemented:
        return `网关还没实现这个接口：${detail}`
      case Code.Internal:
        return `网关内部出错：${detail}`
      default:
        return `请求失败（${codeLabel(error.code)}）：${detail}`
    }
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function codeLabel(code: Code): string {
  switch (code) {
    case Code.Canceled:
      return '已取消'
    case Code.Unknown:
      return '未知'
    case Code.InvalidArgument:
      return '参数不合法'
    case Code.DeadlineExceeded:
      return '超时'
    case Code.NotFound:
      return '找不到'
    case Code.AlreadyExists:
      return '已存在'
    case Code.PermissionDenied:
      return '没权限'
    case Code.ResourceExhausted:
      return '资源用尽'
    case Code.FailedPrecondition:
      return '前置条件不满足'
    case Code.Aborted:
      return '被中止'
    case Code.OutOfRange:
      return '越界'
    case Code.Unimplemented:
      return '没实现'
    case Code.Internal:
      return '内部出错'
    case Code.Unavailable:
      return '不可用'
    case Code.DataLoss:
      return '数据丢失'
    case Code.Unauthenticated:
      return '没鉴权'
    default:
      return String(code)
  }
}

/**
 * 401 的时候要把面板送回令牌输入页。
 *
 * 403 不算：那是「令牌没问题，只是不许」，把令牌清掉反而更糟。
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.Unauthenticated
}
