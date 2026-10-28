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
 * 上游组下拉把全部上游都列出来。
 *
 * 能不能接由后端说（Upstream.state）。面板不再自己拼
 * 「开着 && 登录了」——后端知道的事情比面板多（额度用尽、正在冷却）。
 * 不能用的也选得到：已经不可用的目标有时候就是要改。
 */
describe('上游组下拉', () => {
  it('全部上游都列出来，能用的排前面', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder-cn', 'Qoder 中国区', {
              enabled: false,
              state: UpstreamState.DISABLED,
            }),
            upstream('qoder', 'Qoder 全球区', { modelCount: 6 }),
            upstream('workbuddy-cn', 'WorkBuddy 中国区', {
              state: UpstreamState.NO_CREDENTIAL,
              credential: CredentialState.MISSING,
            }),
            upstream('tokenrhythm', 'TokenRhythm', { modelCount: 2 }),
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

    // 不能用的也在下拉里。
    expect(
      await screen.findByRole('option', { name: /Qoder 中国区/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: /WorkBuddy 中国区/ })
    ).toBeInTheDocument()

    // 能用的排在前面。
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Qoder 全球区（6 个模型）',
      'TokenRhythm（2 个模型）',
      'Qoder 中国区（开关关着，没有模型）',
      'WorkBuddy 中国区（没登录，没有模型）',
    ])
  })

  it('行里说清楚为什么现在不能选', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder', 'Qoder 全球区', { modelCount: 6 }),
            upstream('sensenova', 'Sensenova', {
              state: UpstreamState.COOLING,
              modelCount: 3,
            }),
            upstream('tokenrhythm', 'TokenRhythm', {
              state: UpstreamState.OUT_OF_CREDITS,
              modelCount: 1,
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

    expect(
      await screen.findByRole('option', { name: /Sensenova/ })
    ).toHaveTextContent('Sensenova（正在冷却，3 个模型）')
    expect(
      screen.getByRole('option', { name: /TokenRhythm/ })
    ).toHaveTextContent('TokenRhythm（额度用完了，1 个模型）')
    // 能用的那一行还是老样子。
    expect(
      screen.getByRole('option', { name: /Qoder 全球区/ })
    ).toHaveTextContent('Qoder 全球区（6 个模型）')
  })

  it('不能用的上游也选得到', async () => {
    const user = userEvent.setup({ delay: null })
    const picked: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder', 'Qoder 全球区', { modelCount: 6 }),
            upstream('sensenova', 'Sensenova', {
              state: UpstreamState.COOLING,
              modelCount: 3,
            }),
          ],
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
    await user.click(await screen.findByRole('option', { name: /Sensenova/ }))

    await waitFor(() => {
      expect(picked).toEqual(['sensenova'])
    })
  })

  it('一个模型都没有的上游说清楚没有模型', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('sensenova', 'Sensenova', {
              state: UpstreamState.COOLING,
              modelCount: 0,
            }),
            // 目录空着的上游：就绪，但一个模型也没有。
            upstream('intern-ai', 'InternAI', {
              state: UpstreamState.READY,
              modelCount: 0,
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

    expect(
      await screen.findByRole('option', { name: /Sensenova/ })
    ).toHaveTextContent('Sensenova（正在冷却，没有模型）')
    expect(
      screen.getByRole('option', { name: /InternAI/ })
    ).toHaveTextContent('InternAI（没有模型）')
  })

  it('一个上游都没有时下拉是灰的', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [] }),
    })

    renderWithClient({
      client,
      children: <GroupPicker value='' onChange={() => {}} />,
    })

    expect(
      await screen.findByText(/先在 Provider 页登录并打开一个 Provider/)
    ).toBeInTheDocument()
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
