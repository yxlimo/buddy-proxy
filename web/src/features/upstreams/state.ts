import {
  CredentialState,
  UnpublishedReason,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 上游状态的人话。
 *
 * 面板不再自己拼「开着 && 登录了」——能不能接由后端说，state 说了算。
 */
export const UPSTREAM_STATE_LABELS: Record<UpstreamState, string> = {
  [UpstreamState.UNSPECIFIED]: '未知',
  [UpstreamState.READY]: '就绪',
  [UpstreamState.DISABLED]: '已停用',
  [UpstreamState.NO_CREDENTIAL]: '没登录',
  [UpstreamState.CREDENTIAL_EXPIRED]: '登录过期了',
  [UpstreamState.CREDENTIAL_REJECTED]: '登录被拒了',
  [UpstreamState.OUT_OF_CREDITS]: '额度用完',
  [UpstreamState.LOGGING_IN]: '正在登录',
}

/**
 * 不能选的时候说清楚为什么。
 *
 * 一句话，短的，能塞进下拉那一行。
 */
export const UPSTREAM_STATE_HINTS: Record<UpstreamState, string> = {
  [UpstreamState.UNSPECIFIED]: '状态未知',
  [UpstreamState.READY]: '现在能用',
  [UpstreamState.DISABLED]: '开关关着',
  [UpstreamState.NO_CREDENTIAL]: '没登录',
  [UpstreamState.CREDENTIAL_EXPIRED]: '登录过期了',
  [UpstreamState.CREDENTIAL_REJECTED]: '登录被拒了',
  [UpstreamState.OUT_OF_CREDITS]: '额度用完了',
  [UpstreamState.LOGGING_IN]: '正在登录',
}

/** 凭据状态的人话。 */
export const CREDENTIAL_STATE_LABELS: Record<CredentialState, string> = {
  [CredentialState.UNSPECIFIED]: '未知',
  [CredentialState.AUTHENTICATED]: '可用',
  [CredentialState.MISSING]: '缺失',
  [CredentialState.EXPIRED]: '已过期',
  [CredentialState.ERROR]: '出错',
  [CredentialState.USABLE]: '可用',
  [CredentialState.ANONYMOUS]: '可用',
}

/** 模型没被根路由公布的原因。 */
export const UNPUBLISHED_REASON_LABELS: Record<UnpublishedReason, string> = {
  [UnpublishedReason.UNSPECIFIED]: '未公布',
  [UnpublishedReason.DISABLED]: '模型被停用了',
  [UnpublishedReason.UPSTREAM_DISABLED]: '目标的上游关着',
  [UnpublishedReason.NO_CREDENTIAL]: '目标的上游没登录',
  [UnpublishedReason.MODEL_GONE]: '目标的上游不列这个模型了',
  [UnpublishedReason.TARGET_DISABLED]: '目标被停用了',
  [UnpublishedReason.NO_TARGET]: '没有能用的目标',
}

/** 这个上游现在能不能接请求。 */
export function isUpstreamReady(state: UpstreamState): boolean {
  return state === UpstreamState.READY
}

/** 徽章的色调。 */
export function upstreamStateVariant(
  state: UpstreamState
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case UpstreamState.READY:
      return 'default'
    case UpstreamState.DISABLED:
    case UpstreamState.LOGGING_IN:
    case UpstreamState.UNSPECIFIED:
      return 'secondary'
    case UpstreamState.NO_CREDENTIAL:
    case UpstreamState.CREDENTIAL_EXPIRED:
    case UpstreamState.CREDENTIAL_REJECTED:
    case UpstreamState.OUT_OF_CREDITS:
      return 'destructive'
    default:
      return 'outline'
  }
}

/** 凭据徽章的色调。 */
export function credentialStateVariant(
  state: CredentialState
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case CredentialState.AUTHENTICATED:
    case CredentialState.USABLE:
    case CredentialState.ANONYMOUS:
      return 'default'
    case CredentialState.MISSING:
    case CredentialState.EXPIRED:
    case CredentialState.ERROR:
      return 'destructive'
    case CredentialState.UNSPECIFIED:
      return 'secondary'
    default:
      return 'outline'
  }
}
