import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  ListCredentialsResponseSchema,
  CredentialSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useCredentials } from '@/features/accounts/api'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'

function wrapper(client: ReturnType<typeof mockAdminClient>) {
  const queryClient = makeTestQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AdminClientProvider client={client}>{children}</AdminClientProvider>
    </QueryClientProvider>
  )
}

describe('凭据的 hook', () => {
  it('没选账号的时候不去拉凭据', async () => {
    let calls = 0
    const client = mockAdminClient({
      ListCredentials: () => {
        calls += 1
        return create(ListCredentialsResponseSchema, { credentials: [] })
      },
    })

    const { result } = renderHook(() => useCredentials(''), {
      wrapper: wrapper(client),
    })

    // 空串在契约里是「全部账号的凭据」，但页面没选账号时不该发这个请求。
    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle')
    })
    expect(calls).toBe(0)
    expect(result.current.data).toBeUndefined()
  })

  it('选了账号就去拉那个账号的凭据', async () => {
    const seen: string[] = []
    const client = mockAdminClient({
      ListCredentials: (input) => {
        seen.push(input.accountId ?? '')
        return create(ListCredentialsResponseSchema, {
          credentials: [
            create(CredentialSchema, {
              id: 'cred-1',
              accountId: input.accountId ?? '',
              kind: 'refresh_token',
              masked: 'eyJh****',
              fingerprint: 'a1b2',
              status: 'usable',
            }),
          ],
        })
      },
    })

    const { result } = renderHook(() => useCredentials('acc-1'), {
      wrapper: wrapper(client),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(seen).toEqual(['acc-1'])
    expect(result.current.data?.credentials).toHaveLength(1)
  })
})
