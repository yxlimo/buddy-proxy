import { useMemo, useSyncExternalStore } from 'react'

/**
 * 平台在面板上的排列次序。
 *
 * 次序只存在浏览器里，不传后端：它是操作者自己看着顺眼，不影响网关往哪家发。
 * 平台页、额度页、签到页的行都照它排，三处都从这里取，不各写一遍。
 */
export const PLATFORM_ORDER_KEY = 'buddy.panel.platformOrder'

/** 次序里认得的 id；读不到就是空数组。 */
let cachedRaw: string | null | undefined
let cachedIds: string[] = []

const listeners = new Set<() => void>()

/**
 * 存次序的那个 localStorage。
 *
 * 隐私模式下访问 `localStorage` 本身就可能抛错，那时当作没有地方存。
 */
function platformStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 把存着的那一段解析成 id 数组：不是字符串的、空串、重复的都不认。 */
function parseOrder(raw: string | null): string[] {
  if (raw === null) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '' && !ids.includes(entry)) {
      ids.push(entry)
    }
  }
  return ids
}

/** 存着的那一份次序（缓存着，好让订阅方拿到同一个引用）。 */
function readOrder(): string[] {
  let raw: string | null = null
  try {
    raw = platformStorage()?.getItem(PLATFORM_ORDER_KEY) ?? null
  } catch {
    // 读不了就当没存：面板按服务端次序摆。
    raw = null
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedIds = parseOrder(raw)
  }
  return cachedIds
}

/** 存着的那一份次序。读不到（隐私模式、没存过）时是空数组。 */
export function readPlatformOrder(): string[] {
  return readOrder()
}

/**
 * 存一份次序，并让订阅方重排。
 *
 * 写不进去（隐私模式）不报错：那一趟就按服务端次序摆。
 */
export function writePlatformOrder(order: readonly string[]): void {
  const ids = parseOrder(JSON.stringify(order))
  const raw = JSON.stringify(ids)
  try {
    platformStorage()?.setItem(PLATFORM_ORDER_KEY, raw)
  } catch {
    // 存不了就算了：下一次读会退回服务端次序。
  }
  cachedRaw = raw
  cachedIds = ids
  for (const listener of listeners) listener()
}

/** 把第 from 位挪到第 to 位，返回新的一份。越界或原地不动时原样返回。 */
export function movePlatformOrder(
  order: readonly string[],
  from: number,
  to: number
): readonly string[] {
  if (from === to) return order
  if (from < 0 || to < 0 || from >= order.length || to >= order.length) {
    return order
  }
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 照存下来的次序排一份平台清单。
 *
 * 清单里有、次序里没有的（新出现的平台）排在后面，彼此照服务端次序；
 * 次序里有、清单里没有的（平台删了）直接丢掉。
 */
export function applyPlatformOrder<T extends { id: string }>(
  list: readonly T[],
  order: readonly string[] = readOrder()
): T[] {
  if (order.length === 0) return [...list]
  const rank = new Map<string, number>()
  for (const [index, id] of order.entries()) {
    if (!rank.has(id)) rank.set(id, index)
  }
  return list
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.item.id) ?? Number.POSITIVE_INFINITY
      const rightRank = rank.get(right.item.id) ?? Number.POSITIVE_INFINITY
      return leftRank - rightRank || left.index - right.index
    })
    .map(({ item }) => item)
}

/** 订阅次序的变化：别处存了新次序，页面上跟着重排。 */
function subscribePlatformOrder(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件读当前次序。存着的那份变了会重新渲染。 */
export function usePlatformOrder(): string[] {
  return useSyncExternalStore(
    subscribePlatformOrder,
    readPlatformOrder,
    readPlatformOrder
  )
}

/** 组件读一份按存下来的次序排好的平台清单。 */
export function useOrderedPlatforms<T extends { id: string }>(
  list: readonly T[]
): T[] {
  const order = usePlatformOrder()
  return useMemo(() => applyPlatformOrder(list, order), [list, order])
}
