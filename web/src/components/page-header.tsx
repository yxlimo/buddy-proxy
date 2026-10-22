import { cn } from '@/lib/utils'

type PageHeaderProps = {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

/** 每页顶部的标题块。 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 pb-2 sm:flex-row sm:items-start sm:justify-between',
        className
      )}
    >
      <div className='grid gap-1'>
        <h1 className='text-2xl font-semibold tracking-tight'>{title}</h1>
        {description ? (
          <p className='text-sm text-muted-foreground'>{description}</p>
        ) : null}
      </div>
      {actions ? <div className='flex shrink-0 gap-2'>{actions}</div> : null}
    </div>
  )
}
