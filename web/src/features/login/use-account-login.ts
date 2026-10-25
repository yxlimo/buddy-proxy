import { useState } from 'react'
import { useBeginLogin } from '@/features/login/api'
import { useLoginIdInHash } from '@/features/login/hash'

/** 这次登录是给哪个账号开的。 */
type LoginTarget = {
  upstreamId: string
  accountId: string
  label: string
}

/**
 * 一次账号登录。
 *
 * 管着两样东西：URL 的 hash 里的 login_id（刷新页面还能接上），和这次登录
 * 是给哪个账号开的（对话框要拿它去问后端）。
 */
export function useAccountLogin() {
  const [loginId, setLoginId] = useLoginIdInHash()
  const [target, setTarget] = useState<LoginTarget | null>(null)
  const beginLogin = useBeginLogin()

  /** 点「登录」：开一次会话，把 login_id 写进 hash。 */
  const start = (account: {
    upstreamId: string
    id: string
    label: string
  }) => {
    setTarget({
      upstreamId: account.upstreamId,
      accountId: account.id,
      label: account.label || account.id,
    })
    beginLogin.mutate(
      { upstreamId: account.upstreamId, accountId: account.id },
      {
        onSuccess: (session) => {
          if (!session) {
            setTarget(null)
            return
          }
          setLoginId(session.loginId)
        },
        onError: () => {
          setTarget(null)
        },
      }
    )
  }

  /** 关掉登录：hash 里的 login_id 也清掉，别留个接不上的会话。 */
  const close = () => {
    setTarget(null)
    setLoginId('')
  }

  return {
    /** hash 里的 login_id。空 = 没有在进行的登录。 */
    loginId,
    /** 这次登录的账号。 */
    target,
    start,
    close,
    /** 正在发起登录。 */
    pending: beginLogin.isPending,
  }
}
