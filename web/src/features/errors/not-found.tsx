import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

export function NotFound() {
  return (
    <div className='flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center'>
      <p className='text-4xl font-semibold'>404</p>
      <p className='text-sm text-muted-foreground'>页面不存在。</p>
      <Button asChild>
        <Link to='/'>回到总览</Link>
      </Button>
    </div>
  )
}
