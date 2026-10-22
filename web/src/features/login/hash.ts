import { useCallback, useEffect, useState } from 'react'

/**
 * 没走完的登录放在 URL 的 hash 里。
 *
 * 面板刷新之后要接得上：后端那边会话还在（存在 cache 表里），只要还有
 * login_id 就能继续问进度。
 *
 * 路由用的是 history（路径），hash 路由没用，所以放那儿不跟路由打架。
 * 面板自己的管理令牌不进 URL —— 它在 localStorage 里。
 */
const PARAM = 'login'

/** 从 hash 里读出 login_id。 */
export function readLoginId(hash: string): string {
  const raw = hash.replace(/^#/, '')
  if (!raw) return ''
  try {
    return new URLSearchParams(raw).get(PARAM) ?? ''
  } catch {
    return ''
  }
}

/**
 * 把 login_id 写进 hash。
 *
 * 用 replaceState：不往历史里塞一条，用户按「后退」不会退回登录状态。
 */
export function writeLoginId(loginId: string): void {
  const params = new URLSearchParams(
    window.location.hash.replace(/^#/, '')
  )
  if (loginId) {
    params.set(PARAM, loginId)
  } else {
    params.delete(PARAM)
  }
  const next = params.toString()
  const url = `${window.location.pathname}${window.location.search}${
    next ? `#${next}` : ''
  }`
  window.history.replaceState(window.history.state, '', url)
}

/**
 * 当前 URL 里带着的 login_id。
 *
 * 页面刚打开时读一次；之后 hash 变了（用户自己改了地址栏）也跟着变。
 */
export function useLoginIdInHash(): [string, (loginId: string) => void] {
  const [loginId, setLoginId] = useState(() =>
    typeof window === 'undefined' ? '' : readLoginId(window.location.hash)
  )

  useEffect(() => {
    const onChange = () => setLoginId(readLoginId(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const set = useCallback((next: string) => {
    writeLoginId(next)
    setLoginId(next)
  }, [])

  return [loginId, set]
}
