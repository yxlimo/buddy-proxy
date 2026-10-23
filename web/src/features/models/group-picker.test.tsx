import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CredentialState,
  CredentialStatusSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { GroupPicker } from '@/features/models/group-picker'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function upstream(
  id: string,
  label: string,
  options: {
    enabled?: boolean
    state?: UpstreamState
    credential?: CredentialState
    modelCount?: number
  } = {}
) {
  return create(UpstreamSchema, {
    id,
    label,
    enabled: options.enabled ?? true,
    state: options.state ?? UpstreamState.READY,
    modelCount: options.modelCount ?? 0,
    credential: create(CredentialStatusSchema, {
      status: options.credential ?? CredentialState.AUTHENTICATED,
      kind: 'session',
    }),
  })
}

/**
 * 上游组下拉只列能用的上游。
 *
 * 能不能接由后端说（Upstream.state）。前端不再自己拼
 * 「开着 && 登录了」——后端知道的事情比面板多（额度用尽、正在登录）。
 */
describe('上游组下拉', () => {
  it('只列 state 是 READY 的上游', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder', 'Qoder 全球区', { modelCount: 6 }),
            upstream('minimax', 'MiniMax Code', { modelCount: 2 }),
            // 开关关着
            upstream('qoder-cn', 'Qoder 中国区', {
              enabled: false,
              state: UpstreamState.DISABLED,
            }),
            // 没登录
            upstream('workbuddy-cn', 'WorkBuddy 中国区', {
              state: UpstreamState.NO_CREDENTIAL,
              credential: CredentialState.MISSING,
            }),
            // 登录过期了
            upstream('tokenrhythm', 'TokenRhythm', {
              state: UpstreamState.CREDENTIAL_EXPIRED,
              credential: CredentialState.EXPIRED,
            }),
          ],
        }),
    })

    renderWithClient({
      client,
      children: <GroupPicker value='' onChange={() => {}} />,
    })

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeEnabled()
    })
    await user.click(screen.getByRole('combobox'))

    // 能用的两个在
    expect(
      await screen.findByRole('option', { name: /Qoder 全球区/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: /MiniMax Code/ })
    ).toBeInTheDocument()
    // 模型数也带上了
    expect(screen.getByText('Qoder 全球区（6 个模型）')).toBeInTheDocument()

    // 不能用的不在选项里（下面那几行只是说明为什么不能用）
    expect(
      screen.queryByRole('option', { name: /Qoder 中国区/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /WorkBuddy/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /TokenRhythm/ })
    ).not.toBeInTheDocument()
    // 但说得出为什么不能用。
    expect(screen.getByText('Qoder 中国区：开关关着')).toBeInTheDocument()
    expect(screen.getByText('WorkBuddy 中国区：没登录')).toBeInTheDocument()
    expect(screen.getByText('TokenRhythm：登录过期了')).toBeInTheDocument()
  })

  it('说得出每个上游为什么不能选', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder-cn', 'Qoder 中国区', {
              state: UpstreamState.DISABLED,
            }),
            upstream('minimax', 'MiniMax Code', {
              state: UpstreamState.NO_CREDENTIAL,
              credential: CredentialState.MISSING,
            }),
            upstream('tokenrhythm', 'TokenRhythm', {
              state: UpstreamState.OUT_OF_CREDITS,
            }),
            upstream('workbuddy-cn', 'WorkBuddy 中国区', {
              state: UpstreamState.LOGGING_IN,
            }),
          ],
        }),
    })

    renderWithClient({
      client,
      children: <GroupPicker value='' onChange={() => {}} />,
    })

    expect(
      await screen.findByText(/先在上游页登录并打开一个上游/)
    ).toBeInTheDocument()
    expect(screen.getByText('Qoder 中国区：开关关着')).toBeInTheDocument()
    expect(screen.getByText('MiniMax Code：没登录')).toBeInTheDocument()
    expect(screen.getByText('TokenRhythm：额度用完了')).toBeInTheDocument()
    expect(screen.getByText('WorkBuddy 中国区：正在登录')).toBeInTheDocument()
    // 一个可用上游都没有：下拉是灰的。
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('草稿里的组现在不能用了，要说出来', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [upstream('qoder', 'Qoder 全球区')],
        }),
    })

    renderWithClient({
      client,
      children: <GroupPicker value='qoder-cn' onChange={() => {}} />,
    })

    expect(
      await screen.findByText(/现在选的这个组不能用/)
    ).toBeInTheDocument()
  })

  it('选了之后把组名给出去', async () => {
    const user = userEvent.setup({ delay: null })
    const picked: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [upstream('qoder', 'Qoder 全球区')],
        }),
    })

    renderWithClient({
      client,
      children: (
        <GroupPicker value='' onChange={(value) => picked.push(value)} />
      ),
    })

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeEnabled()
    })
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: /Qoder 全球区/ }))

    await waitFor(() => {
      expect(picked).toEqual(['qoder'])
    })
  })
})
