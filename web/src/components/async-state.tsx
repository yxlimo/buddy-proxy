import { AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/errors'

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className='flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground'>
      <Loader2 className='size-4 animate-spin' />
      {label}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}) {
  return (
    <div className='flex flex-col items-center gap-3 py-12 text-center'>
      <AlertTriangle className='size-6 text-destructive' />
      <p className='text-sm text-destructive'>{describeError(error)}</p>
      {onRetry ? (
        <Button variant='outline' size='sm' onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  )
}

export function EmptyState({
  title = '暂无数据',
  description,
  action,
}: {
  title?: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className='flex flex-col items-center gap-3 py-12 text-center'>
      <Inbox className='size-6 text-muted-foreground' />
      <p className='text-sm font-medium'>{title}</p>
      {description ? (
        <p className='text-sm text-muted-foreground'>{description}</p>
      ) : null}
      {action}
    </div>
  )
}
