import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/errors'

export function GeneralError({ error }: { error: unknown }) {
  return (
    <div className='flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center'>
      <p className='text-2xl font-semibold'>面板出错了</p>
      <p className='max-w-lg text-sm text-muted-foreground'>
        {describeError(error)}
      </p>
      <Button asChild>
        <Link to='/'>回到总览</Link>
      </Button>
    </div>
  )
}
