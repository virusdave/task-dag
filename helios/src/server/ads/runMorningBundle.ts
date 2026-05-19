/**
 * In-process Helios implementation of the "morning bundle" pipeline.
 *
 * Replaces the previous sudo+systemctl trigger of
 * gads-run-analysis.service. The whole workflow now runs as the
 * helios user inside the helios-server process — no privilege
 * escalation, no shelling out via sudo, no python anywhere.
 *
 * Pipeline (matches ads/google/scripts/run-morning.sh one-for-one):
 *
 *   1. Pick the freshest snapshot from <repo>/ads/google/snapshots/
 *      (prefers ads-snapshot-live.jsonl; falls back to the newest
 *      non-empty timestamped snapshot).
 *   2. Spawn helios' local `tsx` to run the existing
 *      ads/google/scripts/run-analysis.ts L1→L2 pipeline against that
 *      snapshot. The child is a normal helios-owned process; we
 *      capture its stdout/stderr for diagnostics.
 *   3. Bundle the produced JSON + per-batch CSVs + HTML packet + a
 *      generated README into outputs/prod/bundle/<runId>.zip. We
 *      reuse the system `zip` binary the way the cluster-sweep
 *      download endpoint already does.
 *   4. Hand the resulting summary back so the route can record it.
 *
 * The route layer is responsible for the HTTP-side concerns
 * (single-flight lock, "return triggered immediately, do not block
 * the request on the analysis"). This module is pure pipeline.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { automationRepoPath, getAutomationRepoRoot } from './automationRepoRoot.js'
import { zipDirectoryToBuffer } from './zipDirectory.js'

export interface MorningBundleRunResult {
  runId: string
  bundlePath: string
  bytes: number
  csvCount: number
  snapshotPath: string
  snapshotAgeHours: number
}

export class MorningBundleRunError extends Error {
  constructor(
    message: string,
    public readonly stage: 'snapshot' | 'analysis' | 'bundle',
    public readonly detail?: string,
  ) {
    super(message)
    this.name = 'MorningBundleRunError'
  }
}

export async function runMorningBundle(opts?: {
  onLog?: (line: string) => void
}): Promise<MorningBundleRunResult> {
  const onLog = opts?.onLog ?? (() => {})

  const repoRoot = getAutomationRepoRoot()
  const gadsDir = path.join(repoRoot, 'ads', 'google')
  const snapshotsDir = path.join(gadsDir, 'snapshots')
  const prodDir = path.join(gadsDir, 'outputs', 'prod')
  const bundleDir = path.join(prodDir, 'bundle')
  await fs.mkdir(bundleDir, { recursive: true })

  // 1. Pick freshest snapshot.
  const snapshot = await pickFreshestSnapshot(snapshotsDir)
  if (!snapshot) {
    throw new MorningBundleRunError(
      `No usable snapshot found under ${snapshotsDir}. Drop a fresh Google Ads Editor export into Drive and ingest it via the Ads page (or the auto-poller will do it), then re-run.`,
      'snapshot',
    )
  }
  const snapshotAgeHours = (Date.now() - snapshot.mtimeMs) / 3_600_000
  onLog(`using snapshot ${path.basename(snapshot.path)} (age ${snapshotAgeHours.toFixed(1)}h)`)

  // 2. Spawn tsx to run the existing L1→L2 analysis script. We use
  // helios' own tsx (installed via `npm install` in helios/) rather
  // than `npx tsx`, which would try to fetch tsx from npm at runtime
  // and fail in offline / restricted-egress environments.
  const tsxBin = path.join(repoRoot, 'helios', 'node_modules', '.bin', 'tsx')
  await assertExecutable(tsxBin, 'analysis')

  const analysisScript = path.join(gadsDir, 'scripts', 'run-analysis.ts')
  await assertExists(analysisScript, 'analysis')

  // The analysis script's createLLMClientFromEnv() prefers an
  // explicit env-var path (LLM_ENDPOINT_BASE + LLM_API_KEY /
  // BEDROCK_MANTLE_BEARER_TOKEN). When neither LLM_ENDPOINT_BASE
  // nor OPENAI_BASE_URL is set it falls back to reading a token
  // file under ~/.secret/bedrock/ — that path doesn't exist for
  // the helios user, so the analysis would silently swap in
  // mockL2Prediction() and ship a bundle with 0 CSV rows and an
  // HTML packet whose "main issues" stringified to '[object
  // Object]'. We default the endpoint to the same Bedrock Mantle
  // URL the helios worker already uses (see
  // helios/src/worker/config/env.ts:55) so the env-var path is
  // hit and the LLM call really happens.
  const analysisEnv: Record<string, string> = { ...processEnvAsRecord() }
  if (!analysisEnv.LLM_ENDPOINT_BASE && !analysisEnv.OPENAI_BASE_URL) {
    analysisEnv.LLM_ENDPOINT_BASE =
      analysisEnv.BEDROCK_MANTLE_BASE_URL ??
      'https://bedrock-mantle.us-east-2.api.aws/v1'
  }

  onLog('running L1→L2 analysis')
  const analysis = await runChild(
    tsxBin,
    [analysisScript, '--snapshot', snapshot.path, '--output-dir', prodDir],
    { cwd: gadsDir, env: analysisEnv },
  )
  if (analysis.exitCode !== 0) {
    throw new MorningBundleRunError(
      `run-analysis.ts exited with code ${analysis.exitCode}`,
      'analysis',
      tail(`${analysis.stdout}\n${analysis.stderr}`, 4000),
    )
  }

  // run-analysis.ts swallows LLM failures and falls back to
  // mockL2Prediction() (see ads/google/scripts/run-analysis.ts).
  // The mock has empty ad_actions / trial_plans (→ 0 CSVs) and
  // stringifies anomaly details to '[object Object]' inside the
  // HTML packet's "main issues" field. Detect the fallback by
  // its warning and surface the underlying LLM error instead of
  // shipping a useless bundle.
  const mockWarning = detectMockFallback(analysis.stdout, analysis.stderr)
  if (mockWarning) {
    throw new MorningBundleRunError(
      `L1→L2 analysis fell back to mock predictions: ${mockWarning}. ` +
        `The resulting bundle would have 0 CSV rows and a garbled HTML packet, ` +
        `so it is rejected. Fix the LLM configuration ` +
        `(LLM_ENDPOINT_BASE + BEDROCK_MANTLE_BEARER_TOKEN on helios-server) ` +
        `and retry.`,
      'analysis',
      tail(`${analysis.stdout}\n${analysis.stderr}`, 4000),
    )
  }

  // 3. Identify the new run by the freshest l2-output.json produced.
  const jsonDir = path.join(prodDir, 'json')
  const newestJson = await findNewestMatching(jsonDir, /^run-.*-l2-output\.json$/)
  if (!newestJson) {
    throw new MorningBundleRunError(
      `Analysis completed but no run-*-l2-output.json appeared in ${jsonDir}.`,
      'bundle',
      tail(`${analysis.stdout}\n${analysis.stderr}`, 2000),
    )
  }
  const runId = newestJson.name.replace(/-l2-output\.json$/, '')
  onLog(`run id ${runId}`)

  const htmlPath = path.join(prodDir, 'html', `${runId}-review-packet.html`)
  await assertExists(htmlPath, 'bundle')

  // 4. Stage and zip.
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-morning-bundle-'))
  let bundlePath: string
  let bytes: number
  let csvCount: number
  try {
    await fs.copyFile(newestJson.absPath, path.join(stageDir, 'l2-output.json'))
    await fs.copyFile(htmlPath, path.join(stageDir, 'review-packet.html'))
    await fs.mkdir(path.join(stageDir, 'csv'), { recursive: true })

    const csvDir = path.join(prodDir, 'csv')
    csvCount = 0
    try {
      const entries = await fs.readdir(csvDir)
      for (const name of entries) {
        if (!name.endsWith('.csv')) continue
        await fs.copyFile(path.join(csvDir, name), path.join(stageDir, 'csv', name))
        csvCount += 1
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
    }

    await fs.writeFile(
      path.join(stageDir, 'README.md'),
      renderReadme({ runId, snapshot, snapshotAgeHours }),
      'utf-8',
    )

    bundlePath = path.join(bundleDir, `${runId}.zip`)
    await fs.rm(bundlePath, { force: true })

    // In-process ZIP — see helios/src/server/ads/zipDirectory.ts for
    // why we no longer shell out to the system `zip` binary.
    const zipBuf = await zipDirectoryToBuffer(stageDir)
    await fs.writeFile(bundlePath, zipBuf)
    bytes = zipBuf.byteLength
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true })
  }

  onLog(`bundle ${path.basename(bundlePath)} (${bytes} bytes, ${csvCount} csvs)`)

  return {
    runId,
    bundlePath,
    bytes,
    csvCount,
    snapshotPath: snapshot.path,
    snapshotAgeHours,
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

interface Snapshot {
  path: string
  mtimeMs: number
}

async function pickFreshestSnapshot(snapshotsDir: string): Promise<Snapshot | null> {
  const livePath = path.join(snapshotsDir, 'ads-snapshot-live.jsonl')
  try {
    const stat = await fs.stat(livePath)
    if (stat.isFile() && stat.size > 0) {
      return { path: livePath, mtimeMs: stat.mtimeMs }
    }
  } catch {
    // fall through
  }

  let entries: string[]
  try {
    entries = await fs.readdir(snapshotsDir)
  } catch {
    return null
  }
  let best: Snapshot | null = null
  for (const name of entries) {
    if (!name.startsWith('ads-snapshot-') || !name.endsWith('.jsonl')) continue
    const abs = path.join(snapshotsDir, name)
    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0) continue
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { path: abs, mtimeMs: stat.mtimeMs }
    }
  }
  return best
}

interface NewestEntry {
  name: string
  absPath: string
  mtimeMs: number
}

async function findNewestMatching(dir: string, re: RegExp): Promise<NewestEntry | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  let best: NewestEntry | null = null
  for (const name of entries) {
    if (!re.test(name)) continue
    const abs = path.join(dir, name)
    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { name, absPath: abs, mtimeMs: stat.mtimeMs }
    }
  }
  return best
}

interface ChildResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runChild(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? processEnvAsRecord(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${(err as Error).message}` })
    })
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}

async function assertExecutable(p: string, stage: 'analysis' | 'bundle'): Promise<void> {
  try {
    await fs.access(p, fs.constants.X_OK)
  } catch {
    throw new MorningBundleRunError(
      `Required binary not found / not executable: ${p}`,
      stage,
    )
  }
}

async function assertExists(p: string, stage: 'analysis' | 'bundle'): Promise<void> {
  try {
    await fs.access(p, fs.constants.R_OK)
  } catch {
    throw new MorningBundleRunError(
      `Required file not found: ${p}`,
      stage,
    )
  }
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(-n)
}

function processEnvAsRecord(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * run-analysis.ts prints a warning of the form
 *   ⚠️  LLM unavailable or failed, using mock predictions
 *       Error: <message>
 * to stderr whenever createLLMClientFromEnv() / the predictor
 * throws a recoverable error and it falls back to
 * mockL2Prediction. Detect that warning and return the underlying
 * error message so the route layer can surface it instead of
 * silently shipping a useless bundle.
 */
function detectMockFallback(stdout: string, stderr: string): string | null {
  const haystack = `${stdout}\n${stderr}`
  if (!/using mock predictions/i.test(haystack)) {
    return null
  }
  const m = haystack.match(/Error:\s*([^\n]+)/i)
  return m ? m[1].trim() : 'reason not captured in script output'
}

function renderReadme(args: { runId: string; snapshot: Snapshot; snapshotAgeHours: number }): string {
  const snapshotMtimeIso = new Date(args.snapshot.mtimeMs).toISOString()
  const generatedAtIso = new Date().toISOString()
  return `# Google Ads — morning run ${args.runId}

Generated on ${generatedAtIso} from snapshot:

    ${path.basename(args.snapshot.path)}
    (mtime ${snapshotMtimeIso} — ${args.snapshotAgeHours.toFixed(1)}h old)

> **Snapshot freshness matters.** If the age above is more than a few
> hours, drop a fresh Google Ads Editor export into the canonical
> Drive folder, re-ingest it from the Helios Ads page, and re-run
> "Run morning pipeline now" to regenerate this bundle.

## What's in this bundle

- \`review-packet.html\` — open this first. Per-family risk + the
  full list of recommended actions, with rationale.
- \`csv/\` — Ads Editor CSV batches. Import them into Google Ads
  Editor **in numeric order** (001-, 002-, …) — each batch assumes
  the previous one has already been applied.
- \`l2-output.json\` — machine-readable predictions, kept for audit.

## How to apply

1. Open the HTML review packet, skim the recommendations.
2. In Google Ads Editor, download latest changes from the account.
3. Import each \`csv/NNN-*.csv\` in order via
   *Account → Import → From file*.
4. Review the diff Ads Editor shows. Post any concerns back before
   clicking *Post* in Ads Editor.
`
}

// Re-export for tests / route convenience.
export { automationRepoPath }
