import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// vitest/config re-exports vite's defineConfig and additionally types the
// `test` field; the production `vite build` simply ignores `test`.
import { defineConfig } from 'vitest/config'

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
  test: {
    // The fleet's agent/dev hosts are small (2 cores, ~2 GiB RAM) and
    // swap-bound. Under that memory pressure even a pure-logic test (or a
    // heavy buildServer() boot whose DB probe is caught and degrades to a
    // no-op) can momentarily exceed vitest's 5s default and FLAKE — a
    // false timeout, not a real failure. Give every test real headroom
    // (a genuinely hung/broken test still fails, just later) so a clean
    // checkout runs green and parallel agents don't trip each other.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Cap parallelism so the worker pool's peak RSS doesn't thrash swap
    // (which is itself the thing that makes tests slow enough to time
    // out). One fork per core is the stable sweet spot on these boxes.
    maxWorkers: 2,
    minWorkers: 1,
  },
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
