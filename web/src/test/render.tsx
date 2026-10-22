import type { ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AdminClientProvider, type AdminClient } from '@/features/auth/client-provider'
import { SidebarProvider } from '@/components/ui/sidebar'

/**
 * 测试用的 QueryClient：关掉重试，不做缓存，好让断言稳定。
 */
export function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

type Options = Omit<RenderOptions, 'wrapper'> & {
  client: AdminClient
  queryClient?: QueryClient
}

export function renderWithClient({
  client,
  queryClient,
  children,
  ...options
}: Options & { children: ReactNode }) {
  const qc = queryClient ?? makeTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <AdminClientProvider client={client}>
        {/* 页面外壳里有顶栏，顶栏里的侧边栏开关要 SidebarProvider。 */}
        <SidebarProvider>{children}</SidebarProvider>
      </AdminClientProvider>
    </QueryClientProvider>,
    options
  )
}
