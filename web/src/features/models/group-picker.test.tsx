import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CredentialStatusSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { GroupPicker } from '@/features/models/group-picker'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function upstream(
  id: string,
  label: string,
  options: { enabled?: boolean; status?: string; modelCount?: number } = {}
) {
  return create(UpstreamSchema, {
    id,
    label,
    enabled: options.enabled ?? true,
    modelCount: options.modelCount ?? 0,
    credential: create(CredentialStatusSchema, {
      status: options.status ?? 'authenticated',
      kind: 'session',
    }),
  })
}

/**
 * 上游组下拉只列能用的上游。
 *
 * 能用 = 开着 + 凭据是已登录的。没登录的、关掉的都不列：填了也接不了。
 */
describe('上游组下拉', () => {
  it('只列开着而且已登录的上游', async () => {
    const user = userEvent.setup()
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder', 'Qoder 全球区', { modelCount: 6 }),
            upstream('minimax', 'MiniMax Code', { modelCount: 2 }),
            // 关掉的
            upstream('qoder-cn', 'Qoder 中国区', { enabled: false }),
            // 没登录的
            upstream('workbuddy-cn', 'WorkBuddy 中国区', {
              status: 'missing',
            }),
            // 凭据过期的
            upstream('tokenrhythm', 'TokenRhythm', { status: 'expired' }),
          ],
        }),
    })

    renderWithClient({
      client,
      children: <GroupPicker value='' onChange={() => {}} />,
    })

    // 等上游列表到了（下拉在取数据的时候是灰的）。
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

    // 不能用的不在
    expect(screen.queryByText(/Qoder 中国区/)).not.toBeInTheDocument()
    expect(screen.queryByText(/WorkBuddy/)).not.toBeInTheDocument()
    expect(screen.queryByText(/TokenRhythm/)).not.toBeInTheDocument()
  })

  it('一个可用上游都没有的时候显示空状态', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            upstream('qoder-cn', 'Qoder 中国区', { enabled: false }),
            upstream('minimax', 'MiniMax Code', { status: 'missing' }),
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
    // 下拉是灰的，点不开。
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
    const user = userEvent.setup()
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

    // 等上游列表到了（下拉在取数据的时候是灰的）。
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
