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

describe('访问令牌闸门', () => {
  beforeEach(() => {
    // 默认测试环境里是有令牌的，这里把它摘掉，单独测闸门。
    clearToken()
  })

  afterEach(() => {
    // 别的用例还指望有令牌。
    setToken('test-token')
  })

  it('没有访问令牌时显示令牌输入页，且不渲染面板', () => {
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

    expect(screen.getByLabelText('访问令牌')).toBeInTheDocument()
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('访问令牌不正确时说明原因，且不写入存储', async () => {
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

    await user.type(screen.getByLabelText('访问令牌'), 'wrong-token')
    await user.click(screen.getByRole('button', { name: '进入面板' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('alert').textContent).toContain('鉴权未通过')
    // 错的令牌不能落到存储里。
    expect(getToken()).toBe('')
    expect(screen.queryByText('面板内容')).not.toBeInTheDocument()
  })

  it('访问令牌校验通过后写入存储并进入面板', async () => {
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

    await user.type(screen.getByLabelText('访问令牌'), 'good-token')
    await user.click(screen.getByRole('button', { name: '进入面板' }))

    await waitFor(() => {
      expect(screen.getByText('面板内容')).toBeInTheDocument()
    })
    expect(getToken()).toBe('good-token')
  })
})
