import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// 默认当成已经登录，省得每处都填。令牌闸门自己有一个测试文件
// （features/auth/token-gate.test.tsx），那里会先把令牌清掉。
window.localStorage.setItem('buddy.admin.token', 'test-token')

// jsdom 没有 matchMedia，侧边栏的 useIsMobile 要用。补一个假的。
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom 没有 ResizeObserver，cmdk（下拉框）要用。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom 没有 scrollIntoView。
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

afterEach(() => {
  cleanup()
})
