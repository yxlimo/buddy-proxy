import { type QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * 面板挂在网关的 /admin 下面（静态文件也是从那儿取）。basepath 要跟
 * vite 的 base 对上，深链接 /admin/upstreams 才认得出。
 */
function basepath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '')
  return base === '' ? '/' : base
}

/**
 * 路由表是自动生成的，路由本身由 main.tsx 和测试共用这一份构造。
 */
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    basepath: basepath(),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}
