import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * 「账号与凭据」已经并进「Provider」页。
 *
 * 老链接留着：进这一页就跳到 Provider 页去。
 */
export const Route = createFileRoute('/_authenticated/accounts')({
  beforeLoad: () => {
    throw redirect({ to: '/upstreams' })
  },
})
