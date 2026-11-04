import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  CreditSummarySchema,
  QuotaPluginSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { MessageInitShape } from '@bufbuild/protobuf'
import type { QuotaRegistry } from '@/features/accounts/provider-key-fields'
import { OpenPlatformFacts } from '@/features/open-platforms/platform-facts'
import { formatLocalMoment } from '@/lib/format'

/**
 * 额度那一栏按服务端给的结论说。
 *
 * 七种状态各说一句，不能并成「未知」，也不能写成 0：写成 0 是替上游说「一点
 * 不剩」，那是它没说过的话。状态名由面板定，`message` 是插件写的一句话（可能
 * 为空）——只靠它的话，没钱与账号不能用会挤成同一句。
 */

/** 服务端说的上一次拉目录的时刻。 */
const FETCHED_AT = BigInt(Date.UTC(2026, 10, 3, 4, 0, 0))
/** 服务端说的恢复时刻。 */
const RECOVER_AT = BigInt(Date.UTC(2027, 0, 15, 11, 30, 0))

/** 登记表里那一个插件。 */
const PLUGIN = create(QuotaPluginSchema, {
  id: 'qiniu-portal',
  label: '七牛门户',
  fields: [],
})

/** 登记表到手：里面就是这个插件。 */
const READY: QuotaRegistry = { status: 'ready', plugins: [PLUGIN] }

/** 一个开放平台的额度栏。 */
function facts(
  quota: MessageInitShape<typeof UpstreamQuotaSchema>,
  registry: QuotaRegistry = READY
) {
  const upstream = create(UpstreamSchema, {
    id: 'my-gateway',
    label: '我的中转站',
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    isOpenPlatform: true,
    quotaPlugin: 'qiniu-portal',
    models: ['gpt-4o'],
    modelsSource: 'auto',
    modelsFetchedAtMs: FETCHED_AT,
    quota: create(UpstreamQuotaSchema, quota),
  })
  return <OpenPlatformFacts upstream={upstream} registry={registry} />
}

/** 全页文字：断言「哪里都没有 0」时用它。 */
function text(): string {
  return document.body.textContent ?? ''
}

describe('额度那一栏按结论说', () => {
  it('ok：显示数字，不显示状态名', () => {
    render(
      facts({
        quotaState: 'ok',
        credits: create(CreditSummarySchema, {
          total: 2000,
          used: 800,
          remaining: 1200,
        }),
      })
    )

    expect(screen.getByText('额度：七牛门户')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    expect(screen.queryByText('额度用尽')).not.toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
  })

  it('no_quota：额度用尽，带恢复时刻，不显示 0', () => {
    render(
      facts({
        quotaState: 'no_quota',
        recoverAtMs: RECOVER_AT,
        message: '资源包已用尽',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(
      screen.getByText(`额度用尽 · ${when} 恢复`)
    ).toBeInTheDocument()
    // 插件那一句话另起一行：状态名不靠它，它只是补充。
    expect(screen.getByText('资源包已用尽')).toBeInTheDocument()
    // 没有数字：不显示那一行，也不显示 0。
    expect(screen.queryByText(/额度：七牛门户/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('blocked：平台说这个账号不能用，带恢复时刻', () => {
    render(
      facts({
        quotaState: 'blocked',
        recoverAtMs: RECOVER_AT,
        message: '账号被停用',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(
      screen.getByText(`平台说这个账号不能用 · ${when} 恢复`)
    ).toBeInTheDocument()
    // 与「额度用尽」不是同一句：两种不能接，原因不同。
    expect(screen.queryByText(/额度用尽/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('unauthorized：凭据被拒，不说恢复时刻', () => {
    render(
      facts({
        quotaState: 'unauthorized',
        message: '会话被拒',
      })
    )

    expect(screen.getByText('凭据被拒')).toBeInTheDocument()
    expect(screen.queryByText(/恢复/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('恢复时刻只看服务端给没给：我没列过的状态带了也显示', () => {
    // 哪几种状态会带「什么时候恢复」是服务端定的，面板不另列一份名单 ——
    // 两份名单一旦不同步，服务端给的时刻就被面板藏掉了。
    render(facts({ quotaState: 'unauthorized', recoverAtMs: RECOVER_AT }))

    const when = formatLocalMoment(RECOVER_AT)
    expect(screen.getByText(`凭据被拒 · ${when} 恢复`)).toBeInTheDocument()
  })

  it('rate_limited：被限流，带恢复时刻', () => {
    render(
      facts({
        quotaState: 'rate_limited',
        recoverAtMs: RECOVER_AT,
        message: '同一个会话问得太勤',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(screen.getByText(`被限流 · ${when} 恢复`)).toBeInTheDocument()
    expect(screen.queryByText(/额度用尽|不能用|凭据被拒/)).not.toBeInTheDocument()
  })

  it('missing：还没填凭据', () => {
    render(facts({ quotaState: 'missing' }))

    expect(screen.getByText('还没填凭据')).toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
  })

  it('unknown：未知（问了但问不到）', () => {
    render(facts({ quotaState: 'unknown', message: '网络断了' }))

    expect(screen.getByText('未知')).toBeInTheDocument()
    expect(screen.getByText('网络断了')).toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('quotaState 空串：整栏不渲染', () => {
    render(facts({ quotaState: '' }))

    // 没有结论就什么都不说：不写「未知」，不写 0，也不摆一个空位。
    expect(screen.queryByText(/^额度：/)).not.toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    // 上面那几行还在（地址、目录、插件），只是没有额度这一栏。
    expect(screen.getByText('额度插件：七牛门户')).toBeInTheDocument()
  })

  it('没结论但有数字（不走插件的种类）：数字照旧显示', () => {
    render(
      facts({
        quotaState: '',
        credits: create(CreditSummarySchema, {
          total: 2000,
          used: 800,
          remaining: 1200,
        }),
      })
    )

    // 套餐额度/积分/余额这几样在插件之外的老路径上，`quota_state` 是空的 ——
    // 数字是服务端给的，不能因为没有状态名就丢掉。
    expect(screen.getByText('额度：七牛门户')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
  })
})

/**
 * 登记表只是一张名字表：它到没到手，跟服务端说的额度结论无关。
 *
 * 结论在 `quotaState` 上，把「额度用尽」藏起来等于把服务端说的话丢了；插件那
 * 一行则要说准是三档里的哪一档 —— 加载中、取不到都不能说成「没登记」。
 */
describe('登记表没到手：额度结论照服务端说的显示', () => {
  it('加载中：额度结论照显示，插件那一行只说还没加载', () => {
    render(facts({ quotaState: 'no_quota' }, { status: 'pending' }))

    expect(screen.getByText('额度用尽')).toBeInTheDocument()
    expect(
      screen.getByText('额度插件：qiniu-portal（列表还没加载）')
    ).toBeInTheDocument()
    expect(text()).not.toMatch(/没登记|未知插件/)
  })

  it('取不到：额度结论照显示，插件那一行只说取不到', () => {
    render(
      facts(
        { quotaState: 'blocked', recoverAtMs: RECOVER_AT },
        { status: 'error', message: '问不到' }
      )
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(
      screen.getByText(`平台说这个账号不能用 · ${when} 恢复`)
    ).toBeInTheDocument()
    expect(
      screen.getByText('额度插件：qiniu-portal（列表取不到）')
    ).toBeInTheDocument()
    expect(text()).not.toMatch(/没登记|未知插件/)
  })

  it('加载中且有数字：插件名说不准就摆 id，数字照显示', () => {
    render(
      facts(
        {
          quotaState: 'ok',
          credits: create(CreditSummarySchema, {
            total: 2000,
            used: 800,
            remaining: 1200,
          }),
        },
        { status: 'pending' }
      )
    )

    expect(screen.getByText('额度：qiniu-portal')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
  })
})

/**
 * 认不出的状态原样显示。
 *
 * 服务端给的是一串字符串：`constructor`、`toString` 这样的值要是不查自己的表、
 * 退到 Object 原型上，界面上就是一段函数体 —— 那是面板自己的 bug，不是服务端
 * 的结论。
 */
describe('认不出的状态', () => {
  for (const state of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`原值显示：${state}`, () => {
      render(facts({ quotaState: state }))

      expect(screen.getByText(state)).toBeInTheDocument()
      expect(text()).not.toMatch(/native code|function|\[object/)
    })
  }
})
