import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PlatformKindSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PlatformDialog } from '@/features/open-platforms/platform-dialog'
import type { PlatformKindList } from '@/features/open-platforms/platform-kinds'

/**
 * 弹窗交上去的那一单。
 *
 * 新增与修改是两种单子：契约里 UpdatePlatform 没有 kind 这一格，所以改平台的
 * 那一单本身就不带它 —— 不是「带上但 hook 会挑掉」。这里直接看弹窗交出去的东西，
 * 发到线上的请求看不出来（hook 只挑它认识的字段）。
 */

/** 服务端登记的两种方言。 */
const kinds: PlatformKindList = {
  status: 'ready',
  kinds: [
    create(PlatformKindSchema, {
      kind: 'openai',
      label: 'OpenAI 兼容',
      defaultBaseUrl: '',
      modelsFromUpstream: true,
    }),
    create(PlatformKindSchema, {
      kind: 'anthropic',
      label: 'Anthropic 兼容',
      defaultBaseUrl: '',
      modelsFromUpstream: true,
    }),
  ],
}

/** 表里的一个开放平台。 */
const platform = create(UpstreamSchema, {
  id: 'my-gateway',
  kind: 'openai',
  label: '我的中转站',
  baseUrl: 'https://api.example.com/v1',
  quotaPlugin: 'qiniu-portal',
  modelsAuto: true,
  models: ['gpt-4o', 'claude-3'],
  isOpenPlatform: true,
  accounts: [],
})

describe('平台弹窗交出去的那一单', () => {
  it('改平台：没有 kind 这一格', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        platform={platform}
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(submitted).toHaveLength(1)
    // 逐字段对：整单就这几格。
    expect(submitted[0]).toEqual({
      id: 'my-gateway',
      label: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      quotaPlugin: 'qiniu-portal',
      // 开着自动拉：目录不动。
      modelsAuto: true,
      models: [],
    })
    // 多一格都不行：类型建完就改不了。
    expect(submitted[0]).not.toHaveProperty('kind')
  })

  it('新增平台：带 kind，别的格不带', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    render(
      <PlatformDialog
        open
        kinds={kinds}
        registry={{ status: 'ready', plugins: [] }}
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onOpenChange={() => {}}
      />
    )

    await user.type(screen.getByLabelText('平台 id'), 'my-gateway')
    await user.type(screen.getByLabelText('名字'), '我的中转站')
    await user.click(screen.getByRole('button', { name: '加上' }))

    expect(submitted).toEqual([
      {
        id: 'my-gateway',
        label: '我的中转站',
        // 清单到手后默认选第一条。
        kind: 'openai',
        baseUrl: '',
      },
    ])
  })
})
