import { Outlet } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'

export function AuthenticatedLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className={cn('@container/content')}>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
