import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Code, ConnectError } from '@connectrpc/connect'
import { GetSystemStatusResponseSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { TokenGate } from '@/features/auth/token-gate'
import { getToken } from '@/features/auth/token-store'
import { clearToken, setToken } from '@/features/auth/use-admin-token'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

describe('令牌闸门', () => {
  beforeEach(() => {
    // 默认测试环境里是有令牌的，这里把它摘掉，单独测闸门。
    clearToken()
  })

  afterEach(() => {
    // 别的用例还指望有令牌。
    setToken('test-token')
  })

  it('没有令牌的时候给令牌输入页，面板不渲染', () => {
    const client = mockAdminClient({
      GetSystemStatus: () => create(GetSystemStatusResponseSchema, {}),
    })

    renderWithClient({
      client,
      children: (
        <TokenGate>
          <div>面板内容</div>
        </TokenGate>
      ),
    })

    expect(screen.getByLabelText('令牌')).toBeInTheDocument()
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('令牌不对的时候说清楚原因，而且不把它存下来', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      GetSystemStatus: () => {
        throw new ConnectError('面板令牌不对。', Code.Unauthenticated)
      },
    })

    renderWithClient({
      client,
      children: (
        <TokenGate>
          <div>面板内容</div>
        </TokenGate>
      ),
    })

    await user.type(screen.getByLabelText('令牌'), 'wrong-token')
    await user.click(screen.getByRole('button', { name: '进入面板' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('alert').textContent).toContain('鉴权没过')
    // 错的令牌不能落到存储里。
    expect(getToken()).toBe('')
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('令牌对了才存下来，然后进面板', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      GetSystemStatus: () => create(GetSystemStatusResponseSchema, {}),
    })

    renderWithClient({
      client,
      children: (
        <TokenGate>
          <div>面板内容</div>
        </TokenGate>
      ),
    })

    await user.type(screen.getByLabelText('令牌'), 'good-token')
    await user.click(screen.getByRole('button', { name: '进入面板' }))

    await waitFor(() => {
      expect(screen.getByText('面板内容')).toBeInTheDocument()
    })
    expect(getToken()).toBe('good-token')
  })
})
