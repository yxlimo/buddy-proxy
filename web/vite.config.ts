/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  // 网关的地址只给开发时的代理用。面板在生产环境是网关自己托管的静态
  // 文件，请求打回同源，不需要知道网关在哪。
  const env = loadEnv(mode, root, '')
  const gateway = env.GATEWAY_URL || 'http://127.0.0.1:6450'

  // 面板挂在网关的 /admin 下面：静态文件和前端的路由都要认这个前缀。
  // 开发时也用同一个前缀，免得两套行为。
  const base = env.VITE_PANEL_BASE || '/admin/'

  return {
    base,
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        // 契约的生成物。构建前从 lib/gen/ 搬进 .gen/（见 scripts/copy-gen.mjs），
        // 前后端共用一份来源，不要在 web/ 里维护第二份。
        '@/gen': fileURLToPath(new URL('./.gen', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      // lib/gen/ 在 web/ 外面，依赖要从 web/node_modules 里取。
      dedupe: ['@bufbuild/protobuf', '@connectrpc/connect'],
    },
    server: {
      port: 5173,
      // lib/gen/ 在 web/ 外面，开发服务器要允许读它。
      fs: { allow: ['..'] },
      proxy: {
        // Connect 的标准路径。代理过去浏览器就不用管 CORS 了。
        '/buddy.admin.v1.AdminService': {
          target: gateway,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  }
})
