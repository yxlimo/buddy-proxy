import {
  CredentialState,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { Badge } from '@/components/ui/badge'
import {
  CREDENTIAL_STATE_LABELS,
  UPSTREAM_STATE_LABELS,
  credentialStateVariant,
  upstreamStateVariant,
} from '@/features/upstreams/state'

/** 上游的状态徽章：就绪 / 已停用 / 没登录 / 额度用完…… */
export function UpstreamStateBadge({
  state,
  className,
}: {
  state: UpstreamState
  className?: string
}) {
  return (
    <Badge variant={upstreamStateVariant(state)} className={className}>
      {UPSTREAM_STATE_LABELS[state] ?? '未知'}
    </Badge>
  )
}

/** 凭据的状态徽章。 */
export function CredentialStateBadge({
  status,
  className,
}: {
  status: CredentialState
  className?: string
}) {
  return (
    <Badge variant={credentialStateVariant(status)} className={className}>
      {CREDENTIAL_STATE_LABELS[status] ?? '未知'}
    </Badge>
  )
}
