/**
 * Promote-to-advisory apply-and-push (issue #61; retargeted to
 * agent-pain-points by issue #64).
 *
 * Commits one admin-authored advisory entry to `advisories.yaml` in
 * virusdave/agent-pain-points and pushes it to `master`, reusing the
 * parser-config apply discipline (`parsekit/applyConfig.ts`): validate →
 * write → git add → reject no-op → commit → push → reset-on-push-failure,
 * with a subprocess timeout. This path carries a bigger blast radius (a
 * repo-wide WRITE key), so it hardens the git boundary further and
 * serializes all promotions:
 *
 * NOTE: this uses a SEPARATE working-tree clone dir
 * (HELIOS_AGENT_PAIN_POINTS_WRITE_DIR) + its own WRITE deploy key, distinct
 * from the read-only bare mirror in agentPainPointsMirror.ts. The two must
 * not share a dir (design §5 hazard: a bare mirror has no worktree; a
 * working-tree clone needs `.git`).
 *
 * (Before the agent-pain-points migration this committed to
 * virusdave/top-level; the migration moved the canonical advisory storage
 * into the dedicated repo so agent-waste writes no longer bump the canon
 * SHA. The relative file path is unchanged.)
 *
 *   - a module-level async mutex serializes concurrent Helios promotions so
 *     two requests never race on the shared working tree / index;
 *   - each attempt starts from a clean `origin/master` (fetch + reset --hard
 *     + clean) so no stale local commit or untracked cruft leaks in;
 *   - only `docs/agent-runtime/advisories.yaml` is ever staged, verified by a
 *     name-only diff before commit;
 *   - the whole resulting file is re-parsed + re-validated against the catalog
 *     contract as the final safety net before committing;
 *   - push races (non-fast-forward) retry a bounded number of times by
 *     recomputing from fresh `origin/master`, never by rebasing a stale
 *     local commit;
 *   - an ambiguous push (timeout / error after the commit was created) is
 *     resolved by checking whether the commit is reachable from
 *     `origin/master` before reporting failure.
 *
 * When the writable agent-pain-points clone / write key is not configured
 * (nixos-sbc child epic infra), it fails closed with
 * `agent_pain_points_unavailable` and never attempts a write — the endpoint
 * deploys inert until the key lands.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type {
  PromoteAdvisoryFailureCode,
  PromoteAdvisoryRequest,
} from '../../shared/contracts/api/agentWaste.js'
import {
  insertAdvisoryEntry,
  renderAdvisoryEntryLine,
  validateCatalogYaml,
  type AdvisoryEntry,
} from './advisoryCatalog.js'

const execFileAsync = promisify(execFile)

/** Path of the catalog inside the agent-pain-points repo. */
const ADVISORIES_REL_PATH = 'docs/agent-runtime/advisories.yaml'

/** Default write remote; overridable for tests / alternate hosts. */
const DEFAULT_AGENT_PAIN_POINTS_REPO_URL = 'git@github.com:virusdave/agent-pain-points.git'

/**
 * Conventional agenix path for the agent-pain-points WRITE deploy key on the
 * Helios prod host, owned by / readable only by the `helios` service user.
 * Mirrors taskDagMirror.ts's conventional automation read-key path.
 * Provisioned by the nixos-sbc child epic; when absent the promote path
 * fails closed.
 */
const CONVENTIONAL_WRITE_DEPLOY_KEY = '/run/agenix/helios-github-agent-pain-points-write-deploy-key'

const GIT_TIMEOUT_MS = 30_000
const MAX_PUSH_ATTEMPTS = 3

export interface PromoteAdvisoryInput {
  /** The validated promote request (advisory fields + provenance). */
  request: PromoteAdvisoryRequest
  /** Operator email for the commit Author trailer + audit. */
  actorEmail: string
  /** Operator user id for audit provenance. */
  actorUserId: number | null
  /** Fastify request id for audit correlation. */
  requestId: string | null
}

export interface PromoteAdvisorySuccess {
  ok: true
  id: string
  relPath: string
  commitSha: string
  commitUrl: string
  pushed: boolean
}

export interface PromoteAdvisoryFailure {
  ok: false
  code: PromoteAdvisoryFailureCode
  message: string
}

export type PromoteAdvisoryResult = PromoteAdvisorySuccess | PromoteAdvisoryFailure

interface AgentPainPointsWriteConfig {
  repoRoot: string
  deployKey: string | null
  repoUrl: string
}

function envStr(name: string): string | null {
  const v = (process.env[name] ?? '').trim()
  return v === '' ? null : v
}

/**
 * Resolve the writable agent-pain-points clone + write key, or null if
 * unconfigured. Uses a SEPARATE working-tree clone dir from the read-only
 * mirror (design §5 hazard) and its own write key.
 */
export function resolveAgentPainPointsWriteConfig(): AgentPainPointsWriteConfig | null {
  const repoRoot = envStr('HELIOS_AGENT_PAIN_POINTS_WRITE_DIR')
  if (!repoRoot) return null
  const deployKey =
    envStr('HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY') ??
    (existsSync(CONVENTIONAL_WRITE_DEPLOY_KEY) ? CONVENTIONAL_WRITE_DEPLOY_KEY : null)
  const repoUrl =
    envStr('HELIOS_AGENT_PAIN_POINTS_REPO_URL') ?? DEFAULT_AGENT_PAIN_POINTS_REPO_URL
  return { repoRoot, deployKey, repoUrl }
}

/**
 * A network git remote (ssh/https/git protocol) needs the write deploy key to
 * authenticate; a *local* filesystem remote (a bare path or `file://` URL, as
 * used only by tests) does not. We must fail closed on the prod SSH remote if
 * no key is configured rather than silently attempting an unauthenticated push.
 */
export function remoteNeedsDeployKey(repoUrl: string): boolean {
  const url = repoUrl.trim()
  // Explicit local remotes used by tests: absolute path, relative path, or file://.
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('file://')) {
    return false
  }
  // Everything else (git@host:…, ssh://…, https://…, git://…) is a network
  // remote requiring authentication.
  return true
}

function gitEnv(deployKey: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (deployKey) {
    env.GIT_SSH_COMMAND =
      `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new ` +
      `-o IdentitiesOnly=yes -i ${deployKey}`
  }
  return env
}

interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

async function runGit(cfg: AgentPainPointsWriteConfig, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: cfg.repoRoot,
      env: gitEnv(cfg.deployKey),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
    }
  }
}

function fail(code: PromoteAdvisoryFailureCode, message: string): PromoteAdvisoryFailure {
  return { ok: false, code, message }
}

// ── module-level async mutex (serialize all promotions in this process) ──
let promoteChain: Promise<unknown> = Promise.resolve()
function withPromoteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = promoteChain.then(fn, fn)
  // Keep the chain alive regardless of this run's outcome.
  promoteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Today's date (YYYY-MM-DD) in America/New_York (repo convention). */
function nyToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** Owner/repo parsed from a git remote URL, for building a commit link. */
function ownerRepoFromUrl(url: string): string | null {
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

function buildEntry(request: PromoteAdvisoryRequest, added: string): AdvisoryEntry {
  const entry: AdvisoryEntry = {
    id: request.id,
    status: request.status,
    scope: request.scope,
    severity: request.severity,
    max_tokens: request.max_tokens,
    text: request.text,
    trigger_ids: request.trigger_ids,
    added,
  }
  if (request.expires_after_days !== undefined) entry.expires_after_days = request.expires_after_days
  if (request.promote_to_guardrail !== undefined) entry.promote_to_guardrail = request.promote_to_guardrail
  if (request.notes !== undefined) entry.notes = request.notes
  return entry
}

function buildCommitMessage(input: PromoteAdvisoryInput): string {
  const { request } = input
  return [
    `advisories: promote ${request.id} via helios agent-waste review`,
    '',
    `Add a human-reviewed ${request.status} advisory to the injected allowlist.`,
    '',
    `Advisory-Id: ${request.id}`,
    `Source-Observation-Id: ${request.sourceObservationId}`,
    `Helios-Actor-User-Id: ${input.actorUserId ?? '(unknown)'}`,
    `Helios-Actor-Email: ${input.actorEmail}`,
    `Helios-Request-Id: ${input.requestId ?? '(none)'}`,
    `Helios-Request-At: ${new Date().toISOString()}`,
    `Helios-Route: POST /api/agent-waste/promote`,
  ].join('\n')
}

/**
 * Promote one advisory entry: validate against the catalog contract, commit,
 * and push to agent-pain-points master. Serialized + bounded-retry. All failures are
 * structured; a push failure never leaves a local commit behind.
 */
export function promoteAdvisory(input: PromoteAdvisoryInput): Promise<PromoteAdvisoryResult> {
  return withPromoteLock(() => promoteAdvisoryLocked(input))
}

async function promoteAdvisoryLocked(input: PromoteAdvisoryInput): Promise<PromoteAdvisoryResult> {
  const cfg = resolveAgentPainPointsWriteConfig()
  if (!cfg) {
    return fail(
      'agent_pain_points_unavailable',
      'The writable agent-pain-points clone is not configured (HELIOS_AGENT_PAIN_POINTS_WRITE_DIR). ' +
        'The promote write path is inert until the agent-pain-points write key + clone are provisioned.',
    )
  }
  if (!existsSync(join(cfg.repoRoot, '.git'))) {
    return fail(
      'agent_pain_points_unavailable',
      `HELIOS_AGENT_PAIN_POINTS_WRITE_DIR (${cfg.repoRoot}) is not a git working tree`,
    )
  }

  // Fail closed: a network remote (the prod SSH URL) MUST have a write key,
  // else we would silently attempt an unauthenticated push. Only explicit
  // local file remotes (tests) may run keyless.
  if (remoteNeedsDeployKey(cfg.repoUrl) && !cfg.deployKey) {
    return fail(
      'agent_pain_points_unavailable',
      'The agent-pain-points write deploy key is not configured ' +
        '(HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY / conventional agenix path). Refusing to ' +
        `attempt an unauthenticated push to ${cfg.repoUrl}. The promote write path is inert ` +
        'until the key is provisioned.',
    )
  }

  // Guard against pointing at the wrong repo. When we expect a known
  // owner/repo (a network remote), the actual origin MUST parse to exactly
  // that — a wrong, renamed, or unparseable origin fails closed. Local file
  // remotes (tests) have no owner/repo and skip this identity check.
  const remote = await runGit(cfg, ['remote', 'get-url', 'origin'])
  if (!remote.ok) {
    return fail('git_command_failed', `git remote get-url origin failed: ${remote.stderr.trim()}`)
  }
  const actualRemoteUrl = remote.stdout.trim()
  const expectedOwnerRepo = ownerRepoFromUrl(cfg.repoUrl)
  if (expectedOwnerRepo) {
    const actualOwnerRepo = ownerRepoFromUrl(actualRemoteUrl)
    if (actualOwnerRepo !== expectedOwnerRepo) {
      return fail(
        'git_command_failed',
        `origin remote is ${actualOwnerRepo ?? (actualRemoteUrl || '(empty)')}, ` +
          `expected ${expectedOwnerRepo}; refusing to write`,
      )
    }
  }

  const absPath = join(cfg.repoRoot, ADVISORIES_REL_PATH)
  let lastPushError = ''

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    // 1. Start each attempt from a pristine origin/master.
    const fetch = await runGit(cfg, ['fetch', '--quiet', 'origin', 'master'])
    if (!fetch.ok) {
      return fail('git_command_failed', `git fetch origin master failed: ${fetch.stderr.trim()}`)
    }
    const reset = await runGit(cfg, ['reset', '--hard', 'origin/master'])
    if (!reset.ok) {
      return fail('git_command_failed', `git reset --hard origin/master failed: ${reset.stderr.trim()}`)
    }
    await runGit(cfg, ['clean', '-fdq'])

    // 2. Read + validate the CURRENT catalog; refuse to build on a broken base.
    if (!existsSync(absPath)) {
      return fail(
        'catalog_current_invalid',
        `${ADVISORIES_REL_PATH} not found in agent-pain-points checkout`,
      )
    }
    const currentText = readFileSync(absPath, 'utf8')
    const currentValidation = validateCatalogYaml(currentText)
    if (!currentValidation.ok || !currentValidation.catalog) {
      return fail(
        'catalog_current_invalid',
        `current advisories.yaml is not contract-valid; refusing to append. ` +
          currentValidation.errors.join('; '),
      )
    }

    // 3. Reject a duplicate id against the current catalog.
    if (currentValidation.catalog.advisories.some((a) => a.id === input.request.id)) {
      return fail('id_exists', `an advisory with id "${input.request.id}" already exists`)
    }

    // 4. Build + textually insert the new single-line flow entry.
    const entry = buildEntry(input.request, nyToday())
    let entryLine: string
    try {
      entryLine = renderAdvisoryEntryLine(entry)
    } catch (err) {
      return fail('catalog_edit_unsupported', `could not serialize entry: ${err instanceof Error ? err.message : String(err)}`)
    }
    const inserted = insertAdvisoryEntry(currentText, entryLine)
    if (!inserted.ok) {
      return fail(inserted.code, inserted.message)
    }

    // 5. SAFETY NET: re-parse + re-validate the whole result, and confirm the
    //    new entry round-trips to exactly what we intended.
    const resultValidation = validateCatalogYaml(inserted.text)
    if (!resultValidation.ok || !resultValidation.catalog) {
      return fail(
        'catalog_result_invalid',
        `the edited catalog failed contract validation: ${resultValidation.errors.join('; ')}`,
      )
    }
    const written = resultValidation.catalog.advisories.find((a) => a.id === input.request.id)
    if (!written || !entriesEqual(written, entry)) {
      return fail('catalog_result_invalid', 'the inserted entry did not round-trip to the intended value')
    }

    // 6. Write, stage only the one path, verify staged scope, reject no-op.
    writeFileSync(absPath, inserted.text, 'utf8')
    const add = await runGit(cfg, ['add', '--', ADVISORIES_REL_PATH])
    if (!add.ok) {
      return fail('git_command_failed', `git add failed: ${add.stderr.trim()}`)
    }
    const staged = await runGit(cfg, ['diff', '--cached', '--name-only'])
    if (!staged.ok) {
      return fail('git_command_failed', `git diff --cached failed: ${staged.stderr.trim()}`)
    }
    const stagedPaths = staged.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (stagedPaths.length === 0) {
      return fail('no_op', 'no changes to commit — the catalog already contains this entry')
    }
    if (stagedPaths.length !== 1 || stagedPaths[0] !== ADVISORIES_REL_PATH) {
      await runGit(cfg, ['reset', '--hard', 'origin/master'])
      return fail(
        'unexpected_staged_changes',
        `refusing to commit: unexpected staged paths: ${stagedPaths.join(', ')}`,
      )
    }

    // 7. Commit.
    const commit = await runGit(cfg, [
      '-c',
      `user.email=${input.actorEmail}`,
      '-c',
      'user.name=helios promote-advisory',
      'commit',
      '-m',
      buildCommitMessage(input),
    ])
    if (!commit.ok) {
      await runGit(cfg, ['reset', '--hard', 'origin/master'])
      return fail('git_command_failed', `git commit failed: ${commit.stderr.trim()}`)
    }
    const revParse = await runGit(cfg, ['rev-parse', 'HEAD'])
    const commitSha = revParse.stdout.trim()

    // 8. Push. On failure, distinguish ambiguous-success from a real reject.
    const push = await runGit(cfg, ['push', 'origin', 'HEAD:master'])
    if (push.ok) {
      const pushed = !/Everything up-to-date/i.test(push.stderr + push.stdout)
      return success(cfg, input.request.id, commitSha, pushed)
    }

    // Ambiguous: the commit may have landed even though push reported failure
    // (e.g. a timeout after the server accepted it). Check reachability.
    lastPushError = push.stderr.trim() || push.stdout.trim()
    await runGit(cfg, ['fetch', '--quiet', 'origin', 'master'])
    const reachable = await runGit(cfg, ['merge-base', '--is-ancestor', commitSha, 'origin/master'])
    if (reachable.ok && reachable.code === 0) {
      return success(cfg, input.request.id, commitSha, true)
    }

    // Genuine failure: discard the local commit so nothing piles up, then
    // retry from fresh origin/master if this looks like a push race.
    await runGit(cfg, ['reset', '--hard', 'origin/master'])
    const isRace = /non-fast-forward|fetch first|rejected|stale info|cannot lock ref/i.test(lastPushError)
    if (!isRace || attempt === MAX_PUSH_ATTEMPTS) {
      return fail('git_push_failed', `git push failed: ${lastPushError}`)
    }
    // else: loop and recompute against the new origin/master.
  }

  return fail('git_push_failed', `git push failed after ${MAX_PUSH_ATTEMPTS} attempts: ${lastPushError}`)
}

function success(
  cfg: AgentPainPointsWriteConfig,
  id: string,
  commitSha: string,
  pushed: boolean,
): PromoteAdvisorySuccess {
  const ownerRepo = ownerRepoFromUrl(cfg.repoUrl)
  const commitUrl = ownerRepo ? `https://github.com/${ownerRepo}/commit/${commitSha}` : commitSha
  return { ok: true, id, relPath: ADVISORIES_REL_PATH, commitSha, commitUrl, pushed }
}

function entriesEqual(a: AdvisoryEntry, b: AdvisoryEntry): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.scope === b.scope &&
    a.severity === b.severity &&
    a.max_tokens === b.max_tokens &&
    a.text === b.text &&
    a.trigger_ids.length === b.trigger_ids.length &&
    a.trigger_ids.every((t, i) => t === b.trigger_ids[i]) &&
    a.expires_after_days === b.expires_after_days &&
    a.promote_to_guardrail === b.promote_to_guardrail &&
    a.added === b.added &&
    a.notes === b.notes
  )
}
