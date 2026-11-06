import type { PlatformKind } from '@/gen/buddy/admin/v1/admin_pb'
import { describeError } from '@/lib/errors'

/**
 * 建平台时能选的类型（方言）清单的状态。
 *
 * 清单是服务端登记的：面板不问「能建哪几种」，问清单。服务端将来加一种方言，
 * 面板不改就跟着多一项。
 */
export type PlatformKindList =
  /** 还在加载。 */
  | { status: 'pending' }
  /** 取不到：带着服务端/传输层给的那句话。 */
  | { status: 'error'; message: string }
  /** 到手了：服务端给的这一份，顺序照服务端。 */
  | { status: 'ready'; kinds: PlatformKind[] }

/** 把查询的三档收成一份清单状态。 */
export function platformKindsFrom(query: {
  /** 查询还在加载（还没有数据）。 */
  isPending: boolean
  /** 查询失败了。 */
  isError: boolean
  /** 失败的原因。 */
  error: unknown
  /** 到手时的全部类型。 */
  kinds?: PlatformKind[]
}): PlatformKindList {
  if (query.isPending) return { status: 'pending' }
  if (query.isError) {
    return { status: 'error', message: describeError(query.error) }
  }
  return { status: 'ready', kinds: query.kinds ?? [] }
}

/**
 * 这一条是不是预置的模拟客户端。
 *
 * 判据是服务端给的 `category`，不是 id 或 kind 的形状：两族的 kind 会重名
 * （`qoder` 是模拟客户端，将来也可能是别的），面板不按名字猜。
 */
export function isSimulatedKind(item: PlatformKind): boolean {
  return item.category === 'simulated'
}

/**
 * 下拉里这一条的身份。
 *
 * 方言用 kind：它是「往上讲谁的格式」，一个 kind 一条。模拟客户端用 presetId：
 * 一个 kind 名下可能有好几个平台（Qoder 的全球区与中国区 kind 都是 `qoder`），
 * 拿 kind 当身份两个 Qoder 就分不开、下拉里只能剩一个。
 */
export function platformKindValue(item: PlatformKind): string {
  return isSimulatedKind(item) && item.presetId ? item.presetId : item.kind
}

/**
 * 这个平台是哪一条预置（模拟客户端）。对不上就是 undefined。
 *
 * 认的是 id 与 kind 两样：id 是客户端路径里那一段，也是预置的身份；kind 再核
 * 一遍 —— 用户可以把预置平台删掉、再用同一个 id 建一个方言平台，那时这个 id
 * 已经不是模拟客户端了。清单没到手就说不准，一律 undefined。
 */
export function simulatedPresetOf(
  list: PlatformKindList,
  platform: { id: string; kind: string }
): PlatformKind | undefined {
  if (list.status !== 'ready') return undefined
  return list.kinds.find(
    (item) =>
      isSimulatedKind(item) &&
      item.presetId === platform.id &&
      item.kind === platform.kind
  )
}

/** 清单里这一条类型。清单没到手、或者没有这一条，都是 undefined。 */
function findKind(
  list: PlatformKindList,
  kind: string
): PlatformKind | undefined {
  if (list.status !== 'ready') return undefined
  return list.kinds.find((item) => item.kind === kind)
}

/**
 * 「类型：xxx」这一行摆什么，不摆就返回 null。
 *
 * 弹窗（改平台时的只读那一行）与卡片（平台那一行的配置）共用这一处判据 ——
 * 同一份数据不能两套说法：
 *
 *   清单还在加载 / 取不到   null：说不出名字，raw 值也不摆
 *   命中一条预置的模拟客户端 它给的名字（同一个 kind 下可能有好几个平台，靠 id 认）
 *   清单到手、登记了这一条  它给的 label
 *   清单到手、没登记        raw kind：服务端加了这个方言、面板旧了，摆出来
 *   kind 本身是空串         null：没有类型可说
 */
export function platformKindReadout(
  list: PlatformKindList,
  platform: { id: string; kind: string }
): string | null {
  const kind = platform.kind
  if (!kind) return null
  if (list.status !== 'ready') return null
  const preset = simulatedPresetOf(list, platform)
  if (preset) return preset.label
  return findKind(list, kind)?.label || kind
}

/**
 * 清单还没到手的那句话：加载中 / 取不到（带原因）。到手后是 null。
 *
 * 下拉框下面那行提示与刷新按钮的禁用原因都从这里取。
 */
function listNotice(list: PlatformKindList): string | null {
  switch (list.status) {
    case 'pending':
      return '类型清单还在加载'
    case 'error':
      return `类型清单取不到：${list.message}`
    default:
      return null
  }
}

/**
 * 清单现在怎么了：三档各一句。
 *
 *   pending            还在加载（就是那整句，不要补的）
 *   error              取不到，`hint` 补上原因
 *   到手但一条也没有     没有能选的类型（服务端一个都没给，不是还在加载）
 *   到手且有得选        null：那时候要说的不是「清单怎么了」
 *
 * `placeholder` 是下拉框里那一行字，`hint` 是格子下面补的那行。两处从这一处
 * 取，不会一处说「没有能选」一处说「还在加载」。
 */
function kindNotice(
  list: PlatformKindList
): { placeholder: string; hint: string | null } | null {
  switch (list.status) {
    case 'pending':
      return { placeholder: '类型清单还在加载', hint: null }
    case 'error':
      return { placeholder: '类型清单取不到', hint: listNotice(list) }
    default:
      return list.kinds.length === 0
        ? { placeholder: '没有能选的类型', hint: null }
        : null
  }
}

/** 下拉框里那一行占位：清单还没得选的时候写它。 */
export function platformKindPlaceholder(
  list: PlatformKindList
): string | undefined {
  return kindNotice(list)?.placeholder
}

/** 格子下面补的那行：取不到的时候带上原因，其余到手了就没有这行。 */
export function platformKindHint(list: PlatformKindList): string | null {
  return kindNotice(list)?.hint ?? null
}

/**
 * 「刷新模型目录」按钮存不存在。
 *
 * 判据只有一个：平台自己那一格 `models_from_upstream`（服务端按类型登记表算好、
 * 跟着 Upstream 一起给的那个值）。不看 `ListPlatformKinds` —— 那个清单只有能新建
 * 的那几类，厂商模板（七牛、星火……）与模拟客户端都不在里面，照它判就永远没有
 * 刷新按钮。清单那一格现在只服务「新建平台」。
 */
export type RefreshModelsControl = { show: false } | { show: true }

/** 这一行摆不摆刷新模型目录按钮。 */
export function refreshModelsControl(
  modelsFromUpstream: boolean
): RefreshModelsControl {
  return modelsFromUpstream === true ? { show: true } : { show: false }
}
