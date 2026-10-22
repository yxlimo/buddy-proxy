import { useSyncExternalStore } from 'react'
import {
  clearToken,
  getEffectiveToken,
  getToken,
  setCandidateToken,
  setToken,
  subscribeToken,
} from '@/features/auth/token-store'

export { clearToken, getEffectiveToken, getToken, setCandidateToken, setToken }

/** 面板当前的鉴权令牌。没有令牌时是空串。 */
export function useAdminToken(): string {
  return useSyncExternalStore(subscribeToken, getToken, () => '')
}
