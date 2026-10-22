import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { clearToken } from '@/features/auth/token-store'
import { isAuthError } from '@/lib/errors'

/**
 * 面板的 QueryClient。
 *
 * 401 一律不重试：令牌不对的时候重试只会把面板刷满错误。别的错误重试
 * 两次，因为网关可能正在重启。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (isAuthError(error)) return false
          return failureCount < 2
        },
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
      mutations: {
        retry: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        // 令牌过期或者被换掉了：把面板送回令牌输入页。
        if (isAuthError(error)) {
          clearToken()
        }
      },
    }),
    // mutation 上的 401 也要清令牌：QueryCache 只管 query，mutation 走
    // MutationCache。少了这一段，令牌过期后用户会卡在一个「看起来正常
    // 但什么都不对」的页面上。
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isAuthError(error)) {
          clearToken()
        }
      },
    }),
  })
}
