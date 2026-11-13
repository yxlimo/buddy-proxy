import type { CredentialField, QuotaPlugin } from '@/gen/buddy/admin/v1/admin_pb'
import { describeError } from '@/lib/errors'

/**
 * 面板上填凭据的格子。
 *
 * 一格就是一段凭据，位置就是顺序：SetProviderKeys 的 keys[] 是按位置读的
 * （第一把是推理用的那把，后面几把按额度插件 fields 的顺序）。留空的那一格表示
 * 清掉它。
 *
 * 几格、各叫什么，由服务端的种类声明说（lib/provider-kinds.ts 的
 * CredentialPlan）：面板不再自己留一张按 kind 查的表。那一份两处写过一次，
 * 于是同一个平台有了三种叫法（`推理 API key` / `推理 key` / `推理 key
 * （Discovery）`）。
 */
export interface ProviderKeyField {
  /** 这一格的 id：输入框的 htmlFor。 */
  id: string
  /** 给人看的标签：这一格是什么。 */
  label: string
  /** 标签下面那一行提示：这一格拿来做什么、留空会怎样。 */
  hint?: string
  /** 输入框里的占位提示。 */
  placeholder?: string
}

/** 某一类平台的凭据长什么样：弹窗标题与要填的那几格。 */
export interface ProviderKeyLayout {
  /** 弹窗标题。 */
  title: string
  /** 要填的格子。位置就是顺序。 */
  fields: ProviderKeyField[]
}

/**
 * 种类那一份登记表的状态。
 *
 * 开放平台的推理 key 那一格、模板平台的那几格，都从这一份里来：没到手就不知
 * 道要画几格。
 */
export type ProviderKinds =
  /** 还在加载。 */
  | { status: 'pending' }
  /** 取不到：带着服务端/传输层给的那句话。 */
  | { status: 'error'; message: string }
  /** 到手了：种类 → 标题与格子。 */
  | {
      status: 'ready'
      of: (kind: string) => { title: string; fields: ProviderKeyField[] } | null
    }

/**
 * 额度插件登记表的状态。
 *
 * 开放平台的凭据有几格由登记表决定：登记表没到手就不知道有几格。
 */
export type QuotaRegistry =
  /** 还在加载。 */
  | { status: 'pending' }
  /** 取不到：带着服务端/传输层给的那句话。 */
  | { status: 'error'; message: string }
  /** 到手了：面板能拿到的全部插件。 */
  | { status: 'ready'; plugins: QuotaPlugin[] }

/**
 * 能不能填凭据：这一类平台的凭据入口的状态。
 *
 * 判据都在这一层（providerKeyAccess）：给不给入口、入口现在能不能用、不能用的
 * 原因是什么。各个调用点只照这个结果渲染，不自己另判一遍。
 */
export type ProviderKeyAccess =
  /** 这一类平台不在面板上填凭据：凭据是登录会话，贴 key 服务端会拒。 */
  | { status: 'none' }
  /** 格子数还说不准：登记表还没到。 */
  | { status: 'loading' }
  /** 登记表取不到：格子数说不准，填上去会清掉已有的那几段。 */
  | { status: 'failed'; message: string }
  /** 可以填了：格子就是 layout.fields，位置就是顺序。 */
  | { status: 'ready'; layout: ProviderKeyLayout }

/**
 * 种类登记表的状态：从查询结果翻译成面板要的三档。
 *
 * 只有这一处翻译：调用点不自己判 isPending / isError。
 */
export function providerKindsFrom(query: {
  /** 查询还在加载（还没有数据）。 */
  isPending: boolean
  /** 查询失败了。 */
  isError: boolean
  /** 失败的原因。 */
  error: unknown
  /** 到手时的全部种类。 */
  kinds?: {
    kind: string
    credentialTitle: string
    credentialFields: CredentialField[]
  }[]
}): ProviderKinds {
  if (query.isPending) return { status: 'pending' }
  if (query.isError) {
    return { status: 'error', message: describeError(query.error) }
  }
  const byKind = new Map(
    (query.kinds ?? []).map((row) => [
      row.kind,
      {
        title: row.credentialTitle,
        fields: row.credentialFields.map(toField),
      },
    ])
  )
  return { status: 'ready', of: (kind) => byKind.get(kind) ?? null }
}

/** 契约里的一格 → 面板上的一格。 */
function toField(field: CredentialField): ProviderKeyField {
  return {
    // 服务端给的是这一格的名字（`api-key`、`portal-cookie`）；加种类前缀，免得
    // 一个页面上两个平台的两格撞同一个 htmlFor。
    id: field.name,
    label: field.label,
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
  }
}

/**
 * 额度插件登记表的状态：从查询结果翻译成面板要的三档。
 *
 * 只有这一处翻译：调用点不自己判 isPending / isError，免得几处各写一遍。
 */
export function quotaRegistryFrom(query: {
  /** 查询还在加载（还没有数据）。 */
  isPending: boolean
  /** 查询失败了。 */
  isError: boolean
  /** 失败的原因。 */
  error: unknown
  /** 到手时的全部插件。 */
  plugins?: QuotaPlugin[]
}): QuotaRegistry {
  if (query.isPending) return { status: 'pending' }
  if (query.isError) {
    return { status: 'error', message: describeError(query.error) }
  }
  return { status: 'ready', plugins: query.plugins ?? [] }
}

/**
 * 这一类平台的凭据入口：能不能填凭据，填哪几格。
 *
 * 判据：
 *
 *   - 开放平台（面板上加的表里那一行）：第一格是推理用的 API key（由种类声明
 *     说），后面几格按它选的额度插件的 fields 顺序，一段一段写。平台没选插件、
 *     或者选的插件没登记在册，就只有推理那一格。
 *   - 模板平台：格子由种类的声明说。声明里一格都没有（会话型的那些：MiniMax
 *     Code、Qoder、WorkBuddy、ZCode）就不给入口 —— 它们的凭据是登录会话，贴
 *     key 服务端会拒。
 *
 * 开放平台那一类还要等两份登记表：格子数由它们决定，没到手就只知道有推理那一
 * 格。这时候开弹窗，用户一保存就发上去一个长度 1 的 keys 数组，而服务端
 * setProviderKeys 是按位置写的 —— 插件那几段就被当成空串清掉了。那是静默的
 * 数据丢失，不是显示问题。所以没到手就不给开那个弹窗。
 */
export function providerKeyAccess(input: {
  /** 这一类上游的 kind。 */
  kind: string
  /** 这是不是开放平台（表里的那一行，不是代码里的模板）。 */
  isOpenPlatform: boolean
  /** 平台的名字：开放平台的标题用它。 */
  platformLabel?: string
  /** 这个平台选的额度插件 id。 */
  quotaPlugin?: string
  /** 种类登记表的状态。 */
  kinds: ProviderKinds
  /** 额度插件登记表的状态。 */
  registry: QuotaRegistry
}): ProviderKeyAccess {
  // 种类登记表先判：没有它连推理那一格叫什么都不知道。
  if (input.kinds.status === 'pending') return { status: 'loading' }
  if (input.kinds.status === 'error') {
    return {
      status: 'failed',
      message: `账号类型取不到，凭据格子还说不准：${input.kinds.message}`,
    }
  }
  const declared = input.kinds.of(input.kind)
  // 开放平台先判：它的格子是「种类那一格 + 平台所选插件那几段」，不是照声明
  // 整份抄（声明里只有推理那一格）。
  if (input.isOpenPlatform) return openPlatformAccess(input, declared)
  // 模板平台：格子由种类声明定死，不看插件登记表。
  if (!declared || declared.fields.length === 0) return { status: 'none' }
  return {
    status: 'ready',
    layout: {
      title: declared.title,
      fields: declared.fields.map((field) => ({
        ...field,
        id: `${input.kind}-${field.id}`,
      })),
    },
  }
}

/**
 * 开放平台的凭据入口：推理那一格（来自种类声明）加上平台所选插件那几段。
 *
 * 插件那几段是数据不是代码：插件由平台那一行指名，所以格子数到运行时才定得
 * 下来。登记表没到手就不放行 —— 见 providerKeyAccess 的说明。
 */
function openPlatformAccess(
  input: {
    platformLabel?: string
    quotaPlugin?: string
    registry: QuotaRegistry
  },
  declared: { title: string; fields: ProviderKeyField[] } | null
): ProviderKeyAccess {
  if (input.registry.status === 'pending') return { status: 'loading' }
  if (input.registry.status === 'error') {
    return {
      status: 'failed',
      message: `插件列表取不到，凭据格子数还说不准：${input.registry.message}`,
    }
  }
  const plugin = input.registry.plugins.find(
    (row) => row.id === (input.quotaPlugin ?? '')
  )
  const fields: ProviderKeyField[] = (declared?.fields ?? []).map((field) => ({
    ...field,
    id: `open-platform-${field.id}`,
  }))
  // 插件的 fields 一段就是一段凭据：顺序与服务端写进去的顺序一样。
  for (const field of plugin?.fields ?? []) {
    fields.push({
      id: `open-platform-plugin-${field.name}`,
      // 名字只有一处产出：插件自己的声明，经契约原样过来（与凭据行上那一格
      // 同一个值）。label 空着（老答复）就显示 name 原样，面板不替它编中文。
      label: field.label || field.name,
      hint: `额度插件「${plugin?.label || plugin?.id || ''}」要的一段凭据`,
    })
  }
  return {
    status: 'ready',
    layout: {
      // 一个平台一种业务：标题用平台的名字，种类那一边只说得出「开放平台」。
      title: `${input.platformLabel || '开放平台'}的凭据`,
      fields,
    },
  }
}
