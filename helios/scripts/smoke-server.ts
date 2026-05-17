#!/usr/bin/env tsx
/**
 * Minimal in-process smoke test for the helios Fastify server.
 *
 * Goals:
 *   - Verify `tsc --noEmit` (already covered by the pre-commit hook
 *     running before us) hasn't told the whole truth: actually boot
 *     the server, serve a request, and confirm that the SPA shell +
 *     hashed asset bundle are both reachable end-to-end without a
 *     real port binding (we use `server.inject`).
 *
 * Why not playwright: pre-commit must be cheap, sandbox-friendly, and
 * pure-Node. This script needs no browser, no network, and no DB
 * connection (db pool is lazy and we never hit a DB-backed route).
 *
 * Usage: `tsx scripts/smoke-server.ts` from the helios/ directory.
 * Exits non-zero on any failure.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const heliosRoot = resolve(__dirname, '..')

process.env.APP_BASE_URL ??= 'http://127.0.0.1:3001/'
process.env.DATABASE_URL ??= 'postgres://helios:helios@127.0.0.1:5432/helios_test'
process.env.NODE_ENV ??= 'test'
process.env.SESSION_COOKIE_SECRET ??= 'smoke-test-session-secret-please-rotate'

const clientDist = resolve(heliosRoot, 'dist/client')
const indexHtmlPath = resolve(clientDist, 'index.html')

if (!existsSync(indexHtmlPath)) {
  console.error(
    `[smoke] FAIL: ${indexHtmlPath} not found. Run \`npm run build:client\` first.`,
  )
  process.exit(2)
}

const assetsDir = resolve(clientDist, 'assets')
const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : []
const aJsAsset = assetFiles.find((name) => name.endsWith('.js'))
if (!aJsAsset) {
  console.error(`[smoke] FAIL: no .js bundle found under ${assetsDir}.`)
  process.exit(2)
}

const onDiskBytes = readFileSync(resolve(assetsDir, aJsAsset))

function fail(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`)
  process.exit(1)
}

// Import the *compiled* server so its `__dirname`-relative
// resolution of `dist/client` (which assumes the dist layout) works.
// The pre-commit hook runs `tsc -p tsconfig.server.json` before this
// script, so the built artifact is guaranteed to be current.
const compiledBuildServer = resolve(heliosRoot, 'dist/server/server/app/buildServer.js')
if (!existsSync(compiledBuildServer)) {
  console.error(
    `[smoke] FAIL: ${compiledBuildServer} not found. Run \`npm run build:server\` first.`,
  )
  process.exit(2)
}
const { buildServer } = (await import(compiledBuildServer)) as typeof import('../src/server/app/buildServer.js')
const server = await buildServer()
if (process.env.SMOKE_DEBUG === '1') {
  console.error(server.printRoutes())
}

try {
  // 1) Health check is mounted at /healthzz regardless of base path.
  const health = await server.inject({ method: 'GET', url: '/healthzz' })
  if (health.statusCode !== 200 || !health.body.startsWith('okzz')) {
    fail(`/healthzz returned ${health.statusCode} body=${JSON.stringify(health.body)}`)
  }

  // 2) The SPA shell at / must be HTML, no-store, and reference the
  //    current hashed asset bundle from the index.html on disk.
  const root = await server.inject({ method: 'GET', url: '/' })
  if (root.statusCode !== 200) fail(`/ returned ${root.statusCode}`)
  const ct = String(root.headers['content-type'] ?? '')
  if (!ct.startsWith('text/html')) fail(`/ content-type was ${ct}`)
  const expectedHtml = readFileSync(indexHtmlPath, 'utf8')
  if (root.body !== expectedHtml) {
    fail(`/ body did not match disk index.html (len server=${root.body.length} disk=${expectedHtml.length})`)
  }
  if (!root.body.includes(`/assets/${aJsAsset}`)) {
    fail(`/ body did not reference /assets/${aJsAsset}`)
  }

  // 3) The current hashed asset must serve the REAL bundle bytes, not
  //    the stale-bundle recovery shim. This is the regression that
  //    bricked production: with `wildcard: false`, every /assets/*
  //    request used to fall through to the SPA fallback which
  //    answered .js requests with the recovery script.
  const asset = await server.inject({ method: 'GET', url: `/assets/${aJsAsset}` })
  if (asset.statusCode !== 200) fail(`/assets/${aJsAsset} returned ${asset.statusCode}`)
  const assetCt = String(asset.headers['content-type'] ?? '')
  if (!/javascript/.test(assetCt)) fail(`/assets/${aJsAsset} content-type=${assetCt}`)
  const assetBody = Buffer.isBuffer(asset.rawPayload) ? asset.rawPayload : Buffer.from(asset.body)
  if (assetBody.length !== onDiskBytes.length) {
    fail(
      `/assets/${aJsAsset} body length ${assetBody.length} != on-disk ${onDiskBytes.length} ` +
        '(server may be returning the stale-bundle recovery shim)',
    )
  }
  if (assetBody.includes(Buffer.from('helios stale-bundle reload failed'))) {
    fail(`/assets/${aJsAsset} returned the recovery shim instead of the real bundle`)
  }

  // 4) A genuinely missing JS hash must still trigger the recovery
  //    shim (so stale tabs can recover), not a hard 404.
  const missing = await server.inject({ method: 'GET', url: '/assets/index-DOESNOTEXIST.js' })
  if (missing.statusCode !== 200) fail(`missing .js returned ${missing.statusCode}`)
  if (!missing.body.includes('stale bundle pointer')) {
    fail(`missing .js did not return recovery shim; body=${missing.body.slice(0, 120)}`)
  }

  console.log('[smoke] OK — server boots; / serves SPA shell; /assets/<hash>.js serves real bundle; missing hash recovers.')
} finally {
  await server.close()
}
