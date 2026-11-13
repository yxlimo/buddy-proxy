import type { QuotaPlugin } from '@/gen/buddy/admin/v1/admin_pb'
import { describeError } from '@/lib/errors'

/**
 * 面板上填凭据的格子。
 *
 * 一格就是一段凭据，位置就是顺序：SetProviderKeys 的 keys[] 是按位置读的
 * （第一把是推理用的那把，后面几把按额度插件 fields 的顺序）。留空的那一格表示
 * 清掉它 —— 与七牛云、讯飞星火一个意思。
 *
 * 顺序的依据是服务端 setProviderKeys 按位置读这件事，不是面板自己定的：服务端
 * 改了顺序，这里要跟着改（改了不改，发上去的那几段就写到别的位置去了）。
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
 * 各类平台的凭据形状。
 *
 * 这张表是「面板上填凭据」的入口判据：表里有这一类，才给「API Key」那个按
 * 钮，也才知道要画几格。判据不再用「后端说这一类用 api_key 登录」—— SenseNova、
 * 书生·端砚、TokenRhythm 登录走的是账号密码或验证码，推理用的却是一把 API
 * key，按 login 判就永远没有地方填那一把。
 *
 * 表里的每一类都是服务端 setProviderKeys 认的（见 lib/admin/credentials.ts）：
 * 位置语义由服务端定死，面板只按同样的顺序发上去。
 */
const LAYOUTS: Record<string, ProviderKeyLayout> = {
  qiniu: {
    title: '七牛云凭据',
    fields: [
      {
        id: 'qiniu-api-key',
        label: '推理 API Key',
        hint: '发模型请求用的那一把',
        placeholder: 'sk-…',
      },
      {
        id: 'qiniu-portal-cookie',
        label: '门户 Cookie',
        hint: '只用来查资源包额度，可以留空',
        placeholder: 'c=…',
      },
    ],
  },
  xinghuo: {
    title: '讯飞星火 API Key',
    fields: [
      {
        id: 'xinghuo-api-key',
        label: 'API Key',
        hint: '在讯飞星火控制台创建的推理 key，整串粘贴',
        placeholder: '在讯飞星火控制台复制的 API Key',
      },
    ],
  },
  sensenova: {
    title: 'SenseNova API Key',
    fields: [
      {
        id: 'sensenova-api-key',
        label: '推理 API Key',
        hint: '发模型请求用的那一把；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  'intern-ai': {
    title: '书生·端砚的凭据',
    fields: [
      {
        id: 'intern-ai-discovery-key',
        label: '推理 API Key',
        hint: '推理走的就是这把 key；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  tokenrhythm: {
    title: 'TokenRhythm API Key',
    fields: [
      {
        id: 'tokenrhythm-api-key',
        label: 'API Key',
        hint: '钱包里那把推理用的 key；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
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
 *   - 开放平台（面板上加的表里那一行）：第一格是推理用的 API key，后面几格按
 *     它选的额度插件的 fields 顺序，一段一段写。平台没选插件、或者选的插件没
 *     登记在册，就只有推理那一格。
 *   - 模板平台：按 kind 查那张表（qiniu / xinghuo / sensenova / intern-ai /
 *     tokenrhythm）。表里没有的（会话型的那些：MiniMax、Qoder、WorkBuddy、
 *     ZCode）不给格子 —— 它们的凭据是登录会话，贴 key 服务端会拒。
 *
 * 开放平台那一类还要等额度插件登记表：格子数是登记表说了算的，登记表没到手就
 * 只知道有「推理 API Key」那一格。这时候开弹窗，用户一保存就发上去一个长度
 * 1 的 keys 数组，而服务端 setProviderKeys 是按位置写的（keys[i+1] ?? ""）——
 * 插件那几段就被当成空串清掉了。那是静默的数据丢失，不是显示问题。
 * 所以登记表没到手（还在加载 / 取不到）就不给开那个弹窗。
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
  /** 额度插件登记表的状态。 */
  registry: QuotaRegistry
}): ProviderKeyAccess {
  // 开放平台先判：它的格子由它选的额度插件决定，不是按 kind 查表（模板平台
  // 里没有开放平台这一种，kind 那一格倒是也是 "openai"）。
  if (input.isOpenPlatform) {
    // 登记表没到手：格子数说不准，不给开弹窗。
    if (input.registry.status === 'pending') {
      return { status: 'loading' }
    }
    if (input.registry.status === 'error') {
      return {
        status: 'failed',
        message: `插件列表取不到，凭据格子数还说不准：${input.registry.message}`,
      }
    }
    const plugin = input.registry.plugins.find(
      (row) => row.id === (input.quotaPlugin ?? '')
    )
    const fields: ProviderKeyField[] = [
      {
        id: 'open-platform-api-key',
        label: '推理 API Key',
        hint: '发模型请求用的那一把；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ]
    // 插件的 fields 一段就是一段凭据：顺序与服务端写进去的顺序一样。
    for (const field of plugin?.fields ?? []) {
      fields.push({
        id: `open-platform-plugin-${field.name}`,
        // label 是给人看的名字；name 是库里的后缀，不给人看。
        label: field.label || field.name,
        hint: `额度插件「${plugin?.label || plugin?.id || ''}」要的一段凭据`,
      })
    }
    return {
      status: 'ready',
      layout: {
        title: `${input.platformLabel || '开放平台'}的凭据`,
        fields,
      },
    }
  }
  // 模板平台：格子由那张表定死，不看登记表。
  const layout = LAYOUTS[input.kind] ?? null
  return layout ? { status: 'ready', layout } : { status: 'none' }
}
