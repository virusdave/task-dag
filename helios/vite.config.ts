import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Compute deploy/build metadata at build time and emit it as a side-car
// JSON file under dist/client/ so the client can fetch it at runtime
// for the tiny <BuildStamp /> overlay. We intentionally do NOT bake
// these values into the JS bundle via `define`, because they'd change
// every build (timestamp) and rotate the bundle hash on every redeploy,
// bricking every open browser tab whose cached index.html points at the
// previous hash.
function safeGitOutput(command: string, fallback: string): string {
  try {
    return execSync(command, { encoding: 'utf8' }).trim() || fallback
  } catch {
    return fallback
  }
}

function buildInfoPlugin(): Plugin {
  return {
    name: 'helios-build-info',
    apply: 'build',
    closeBundle() {
      const payload = {
        sha: safeGitOutput('git rev-parse --short=10 HEAD', 'unknown'),
        subject: safeGitOutput("git log -1 --pretty=%s", ''),
        builtAt: new Date().toISOString(),
      }
      writeFileSync(resolve('dist/client/build-info.json'), JSON.stringify(payload))
    },
  }
}

export default defineConfig({
  plugins: [react(), buildInfoPlugin()],
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
