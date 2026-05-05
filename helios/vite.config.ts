import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

import { deriveBasePathFromAppBaseUrl, joinBasePath, toViteBasePath } from './src/shared/config/appBasePath.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appBasePath = env.APP_BASE_URL ? deriveBasePathFromAppBaseUrl(env.APP_BASE_URL) : '/'

  return {
    base: toViteBasePath(appBasePath),
    plugins: [react()],
    test: {
      include: ['src/**/*.test.ts'],
    },
    server: {
      port: 5173,
      // Allow rendering the dev page from a docker-hosted headless browser
      // (host.docker.internal) for screenshot-based UI assessment. Dev-only.
      allowedHosts: ['host.docker.internal', 'localhost', '127.0.0.1'],
      proxy: {
        [joinBasePath(appBasePath, '/api')]: {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist/client',
    },
  }
})
