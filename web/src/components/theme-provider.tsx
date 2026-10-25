import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'buddy.admin.theme'

const ThemeContext = createContext<{
  theme: Theme
  setTheme: (theme: Theme) => void
}>({
  theme: 'system',
  setTheme: () => {},
})

function readStoredTheme(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') {
      return value
    }
  } catch {
    // 隐私模式下 localStorage 可能不让用：就用系统的。
  }
  return 'system'
}

/**
 * 主题：浅色 / 深色 / 跟随系统。
 *
 * 切换立刻生效（class 挂在 <html> 上，CSS 里 .dark 那组 token 就生效了），
 * 选择记在 localStorage 里。index.html 里有一段同样逻辑的内联脚本，
 * 先把 class 摆好，页面不会闪一下白。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system')

  // 挂上之后从存储里读。挂之前 html 的 class 由 index.html 的内联脚本摆好。
  useEffect(() => {
    setThemeState(readStoredTheme())
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark =
        theme === 'dark' ||
        (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 存不了就算了，这一轮还是生效的。
    }
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

export { STORAGE_KEY as THEME_STORAGE_KEY }
