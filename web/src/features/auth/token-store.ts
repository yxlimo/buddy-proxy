// 面板的鉴权令牌。放在 localStorage 里，刷新和关掉标签页都不丢。
//
// 令牌是网关在 /data/admin-token 生成的那一份，0600 权限，跟 agent 侧的
// API key 是两回事。

const STORAGE_KEY = 'buddy.admin.token'

function readStored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 可能不可用，面板就当没登录。
    return ''
  }
}

let token = typeof window === 'undefined' ? '' : readStored()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function getToken(): string {
  return token
}

/**
 * 正在试、还没保存的令牌。
 *
 * 令牌页先拿它去问网关一次，对不对当场就知道；验过了才写进 localStorage。
 * 它只在这一次请求里顶替真的令牌用，不落到存储里。
 */
let candidate: string | null = null

export function getEffectiveToken(): string {
  return candidate ?? token
}

export function setCandidateToken(next: string | null): void {
  candidate = next
}

export function setToken(next: string): void {
  token = next.trim()
  try {
    if (token) {
      window.localStorage.setItem(STORAGE_KEY, token)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // 存不进去就算了，这次会话里还能用。
  }
  notify()
}

export function clearToken(): void {
  setToken('')
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
