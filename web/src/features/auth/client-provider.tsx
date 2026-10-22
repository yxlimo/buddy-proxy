import { createContext, useContext, type ReactNode } from 'react'
import { adminClient, type AdminClient } from '@/lib/admin-client'

// 默认值就是真正的客户端，所以正常使用时不用套 provider。测试里套一个
// 用假 transport 做的客户端进来，hook 那一层就不用改。
const AdminClientContext = createContext<AdminClient>(adminClient)

export function AdminClientProvider({
  client,
  children,
}: {
  client: AdminClient
  children: ReactNode
}) {
  return (
    <AdminClientContext.Provider value={client}>
      {children}
    </AdminClientContext.Provider>
  )
}

export function useAdminClient(): AdminClient {
  return useContext(AdminClientContext)
}

export type { AdminClient }
