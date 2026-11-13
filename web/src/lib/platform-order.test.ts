import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPlatformOrder,
  movePlatformOrder,
  PLATFORM_ORDER_KEY,
  readPlatformOrder,
  writePlatformOrder,
} from '@/lib/platform-order'

/** 一份平台清单：形状照服务端的那一份来，只有 id 跟这里的断言有关。 */
function platforms(...ids: string[]) {
  return ids.map((id) => ({ id, label: id.toUpperCase() }))
}

function idsOf(list: readonly { id: string }[]) {
  return list.map((item) => item.id)
}

beforeEach(() => {
  window.localStorage.removeItem(PLATFORM_ORDER_KEY)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('平台次序的存放', () => {
  it('存进去什么，读出来就是什么', () => {
    writePlatformOrder(['qoder', 'minimax', 'zcode'])

    expect(readPlatformOrder()).toEqual(['qoder', 'minimax', 'zcode'])
    expect(window.localStorage.getItem(PLATFORM_ORDER_KEY)).toBe(
      '["qoder","minimax","zcode"]'
    )
  })

  it('存进去的时候去掉空串与重复的 id', () => {
    writePlatformOrder(['qoder', '', 'qoder', 'minimax'])

    expect(readPlatformOrder()).toEqual(['qoder', 'minimax'])
  })

  it('没存过时是空数组', () => {
    expect(readPlatformOrder()).toEqual([])
  })
})

describe('照次序排一份平台清单', () => {
  it('次序里有的按次序排，与服务端的次序无关', () => {
    const ordered = applyPlatformOrder(
      platforms('minimax', 'qoder', 'zcode'),
      ['zcode', 'qoder', 'minimax']
    )

    expect(idsOf(ordered)).toEqual(['zcode', 'qoder', 'minimax'])
  })

  it('次序里没有的平台排在后面，彼此照服务端次次', () => {
    const ordered = applyPlatformOrder(
      platforms('minimax', 'qoder', 'zcode', 'newcomer'),
      ['zcode', 'minimax']
    )

    expect(idsOf(ordered)).toEqual(['zcode', 'minimax', 'qoder', 'newcomer'])
  })

  it('次序里多出来的 id 直接丢掉：平台已经删了', () => {
    const ordered = applyPlatformOrder(platforms('minimax', 'qoder'), [
      'gone',
      'qoder',
      'minimax',
    ])

    expect(idsOf(ordered)).toEqual(['qoder', 'minimax'])
  })

  it('没存过次序时照服务端次序', () => {
    const ordered = applyPlatformOrder(platforms('minimax', 'qoder'))

    expect(idsOf(ordered)).toEqual(['minimax', 'qoder'])
  })

  it('存着的那一段读不出来时照服务端次序', () => {
    window.localStorage.setItem(PLATFORM_ORDER_KEY, '不是 JSON')

    expect(idsOf(applyPlatformOrder(platforms('minimax', 'qoder')))).toEqual([
      'minimax',
      'qoder',
    ])
  })

  it('存着的不是一个数组时照服务端次序', () => {
    window.localStorage.setItem(PLATFORM_ORDER_KEY, '{"order":["qoder"]}')

    expect(idsOf(applyPlatformOrder(platforms('minimax', 'qoder')))).toEqual([
      'minimax',
      'qoder',
    ])
  })

  it('浏览器不给存（隐私模式）时照服务端次序，不报错', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage 被拒')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage 被拒')
    })

    expect(() => writePlatformOrder(['qoder', 'minimax'])).not.toThrow()
    expect(idsOf(applyPlatformOrder(platforms('minimax', 'qoder')))).toEqual([
      'minimax',
      'qoder',
    ])
  })
})

describe('挪一行的位置', () => {
  it('往后挪一位', () => {
    expect(movePlatformOrder(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  })

  it('往前挪一位', () => {
    expect(movePlatformOrder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('原地不动时原样返回', () => {
    const order = ['a', 'b', 'c']

    expect(movePlatformOrder(order, 1, 1)).toBe(order)
  })

  it('越界时原样返回', () => {
    const order = ['a', 'b', 'c']

    expect(movePlatformOrder(order, 3, 0)).toBe(order)
    expect(movePlatformOrder(order, 0, -1)).toBe(order)
  })
})
