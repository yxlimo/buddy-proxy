import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEME_STORAGE_KEY, ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/layout/theme-toggle'

/**
 * 主题：浅色 / 深色 / 跟随系统。
 *
 * 切换要立刻生效（class 挂在 <html> 上），刷新后记住（存在 localStorage）。
 */
describe('主题切换', () => {
  it('三个选项都在，选了深色就加上 dark 的 class', async () => {
    const user = userEvent.setup()
    window.localStorage.removeItem(THEME_STORAGE_KEY)

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

    await user.click(screen.getByRole('button', { name: '切换主题' }))

    expect(screen.getByRole('menuitem', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '深色' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '跟随系统' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: '深色' }))

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
    // 选择记住了。
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('选回浅色就把 dark 去掉', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })

    await user.click(screen.getByRole('button', { name: '切换主题' }))
    await user.click(screen.getByRole('menuitem', { name: '浅色' }))

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })
})
