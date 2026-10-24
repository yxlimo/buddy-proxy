import { Badge } from '@/components/ui/badge'

const LABELS: Record<string, string> = {
  // 凭据
  authenticated: '可用',
  usable: '可用',
  ok: '正常',
  missing: '缺失',
  expired: '已过期',
  error: '出错',
  // 用量事件
  success: '成功',
  succeeded: '成功',
  failed: '失败',
  // 上游
  enabled: '已启用',
  disabled: '已停用',
  // 余额批次
  active: '有效',
  permanent: '永久',
  used_up: '已用完',
}

/**
 * 状态字符串 → 徽章。认不出来的就原样显示。
 *
 * `labels` 覆盖文案：同一个状态词在账号和凭据上意思不一样（账号的 usable
 * 是「已登录」，凭据的 usable 是「可用」），各说各的。
 */
export function StatusBadge({
  status,
  className,
  labels,
}: {
  status: string | undefined | null
  className?: string
  /** 覆盖默认文案。 */
  labels?: Record<string, string>
}) {
  const key = (status ?? '').trim().toLowerCase()
  if (!key) {
    return (
      <Badge variant='outline' className={className}>
        未知
      </Badge>
    )
  }

  const variant = variantFor(key)
  return (
    <Badge variant={variant} className={className}>
      {labels?.[key] ?? LABELS[key] ?? status}
    </Badge>
  )
}

function variantFor(
  key: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (key) {
    case 'authenticated':
    case 'usable':
    case 'ok':
    case 'success':
    case 'succeeded':
    case 'active':
      return 'default'
    case 'expired':
    case 'error':
    case 'failed':
    case 'missing':
    case 'used_up':
      return 'destructive'
    case 'enabled':
    case 'disabled':
    case 'permanent':
      return 'secondary'
    default:
      return 'outline'
  }
}
