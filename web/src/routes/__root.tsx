import { type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { TokenGate } from '@/features/auth/token-gate'
import { GeneralError } from '@/features/errors/general-error'
import { NotFound } from '@/features/errors/not-found'

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: GeneralError,
})

function RootComponent() {
  return (
    <TokenGate>
      <Outlet />
      <Toaster duration={5000} />
    </TokenGate>
  )
}
