import { execSync } from 'node:child_process'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Compute deploy/build metadata once at config evaluation time so the
// values are baked into the client bundle as compile-time constants.
// Used by the tiny <BuildStamp /> overlay so operators can tell at a
// glance whether they're looking at a stale production deploy.
function safeGitOutput(command: string, fallback: string): string {
  try {
    return execSync(command, { encoding: 'utf8' }).trim() || fallback
  } catch {
    return fallback
  }
}

const buildSha = safeGitOutput('git rev-parse --short=10 HEAD', 'unknown')
const buildSubject = safeGitOutput("git log -1 --pretty=%s", '')
const buildTimeIso = new Date().toISOString()

export default defineConfig({
  define: {
    __HELIOS_BUILD_SHA__: JSON.stringify(buildSha),
    __HELIOS_BUILD_SUBJECT__: JSON.stringify(buildSubject),
    __HELIOS_BUILD_TIME__: JSON.stringify(buildTimeIso),
  },
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})
