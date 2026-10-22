// 契约里的时间戳都是 Unix 毫秒（int64）。
//
// 网关这一侧全是 JS 的 Date.now()，只有名字里带 _sec 的两个是秒：
// GetSystemStatusResponse.uptime_sec 和 CredentialStatus.remaining_sec。
// 契约的注释里没写单位，这里跟网关对齐。

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const numberFormat = new Intl.NumberFormat('zh-CN')

function toNumber(value: bigint | number | undefined | null): number | null {
  if (value === undefined || value === null) return null
  const n = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isFinite(n) || n === 0) return null
  return n
}

export function formatDateTime(
  value: bigint | number | undefined | null
): string {
  const ms = toNumber(value)
  if (ms === null) return '—'
  return dateTimeFormat.format(new Date(ms))
}

export function formatDate(value: bigint | number | undefined | null): string {
  const ms = toNumber(value)
  if (ms === null) return '—'
  return dateFormat.format(new Date(ms))
}

export function formatCount(value: bigint | number | undefined | null): string {
  if (value === undefined || value === null) return '0'
  const n = typeof value === 'bigint' ? Number(value) : value
  return numberFormat.format(n)
}

export function formatCny(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return '¥0.00'
  }
  return `¥${value.toFixed(2)}`
}

export function formatTokens(value: bigint | number | undefined | null): string {
  return formatCount(value)
}

/** 时长（毫秒）。 */
export function formatMillis(value: bigint | number | undefined | null): string {
  if (value === undefined || value === null) return '—'
  const n = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)} 毫秒`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} 秒`
  return `${Math.floor(n / 60_000)} 分 ${Math.round((n % 60_000) / 1000)} 秒`
}

/**
 * 运行时长。
 *
 * uptime_sec 是秒 —— 契约里只有带 _sec 的两个字段是秒。
 */
export function formatUptime(seconds: bigint | number | undefined | null): string {
  const sec = toNumber(seconds)
  if (sec === null) return '—'
  const days = Math.floor(sec / 86_400)
  const hours = Math.floor((sec % 86_400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

/**
 * 剩余天数。
 *
 * 平台用 2099-12-31 标记「永不过期」，那种批次这里给 null，
 * 由界面自己决定怎么显示（日期本身原样透出，不要翻译）。
 */
export function remainingDays(
  expiresAt: bigint | number | undefined | null,
  now: number = Date.now()
): number | null {
  const ms = toNumber(expiresAt)
  if (ms === null) return null
  if (ms <= now) return 0
  return Math.ceil((ms - now) / 86_400_000)
}

/** 远期批次（平台用 2099-12-31 标记）。 */
export function isFarFuture(
  expiresAt: bigint | number | undefined | null
): boolean {
  const ms = toNumber(expiresAt)
  if (ms === null) return false
  return ms >= Date.UTC(2099, 0, 1)
}

/** 倒计时（秒）。登录窗口、批次到期都用它。 */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '已过期'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}
