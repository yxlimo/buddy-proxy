import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/page-header'

type PageShellProps = {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}

/** 一页的外壳：顶栏 + 标题 + 内容。 */
export function PageShell({
  title,
  description,
  actions,
  children,
}: PageShellProps) {
  return (
    <>
      <Header fixed>
        <span className='text-sm font-medium'>{title}</span>
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader title={title} description={description} actions={actions} />
        {children}
      </Main>
    </>
  )
}
