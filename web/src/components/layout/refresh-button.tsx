import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 手动刷新。面板不自动重取（refetchOnWindowFocus 关着），总得有个地方
 * 能让用户自己按一下。
 */
export function RefreshButton() {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0

  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label='刷新'
      title='刷新'
      disabled={fetching}
      onClick={() => {
        void queryClient.invalidateQueries()
      }}
    >
      <RefreshCw className={cn('size-4', fetching && 'animate-spin')} />
    </Button>
  )
}
