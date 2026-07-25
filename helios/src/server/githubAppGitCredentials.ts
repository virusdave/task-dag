import { createSign, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const GITHUB_API = 'https://api.github.com'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const CREDENTIAL_PREFIX = '.github-credential-'

interface InstallationToken {
  token: string
  expiresAtMs: number
}

const installationIds = new Map<string, number>()
const installationTokens = new Map<string, InstallationToken>()

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required for GitHub task repository access`)
  return value
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: requiredEnv('HELIOS_GITHUB_APP_ID'),
  }))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(fs.readFileSync(requiredEnv('HELIOS_GITHUB_APP_PRIVATE_KEY_FILE')), 'base64url')}`
}

async function githubRequest(endpoint: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'FreshlyBakedNYC-Helios',
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`GitHub App request ${endpoint} failed with HTTP ${response.status}`)
  return response.json()
}

function parseInstallationId(value: unknown, repository: string): number {
  if (typeof value !== 'object' || value == null || !('id' in value) ||
      typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error(`GitHub returned an invalid installation response for ${repository}`)
  }
  return value.id
}

function parseInstallationToken(value: unknown, repository: string): InstallationToken {
  if (typeof value !== 'object' || value == null || !('token' in value) || !('expires_at' in value) ||
      typeof value.token !== 'string' || value.token === '' || typeof value.expires_at !== 'string') {
    throw new Error(`GitHub returned an invalid installation token response for ${repository}`)
  }
  const expiresAtMs = Date.parse(value.expires_at)
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`GitHub returned an invalid installation token expiry for ${repository}`)
  }
  return { token: value.token, expiresAtMs }
}

async function installationId(repository: string, jwt: string): Promise<number> {
  const cached = installationIds.get(repository)
  if (cached != null) return cached
  const [owner, name] = repository.split('/')
  const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const id = parseInstallationId(response, repository)
  installationIds.set(repository, id)
  return id
}

async function installationToken(repository: string): Promise<string> {
  const cached = installationTokens.get(repository)
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.token

  const jwt = appJwt()
  const id = await installationId(repository, jwt)
  const name = repository.split('/')[1]
  const response = await githubRequest(`/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ repositories: [name], permissions: { contents: 'read' } }),
  })
  const token = parseInstallationToken(response, repository)
  installationTokens.set(repository, token)
  return token.token
}

function credentialDirectory(): string {
  return requiredEnv('HELIOS_GITHUB_APP_CREDENTIAL_DIR')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function prepareGithubAppGitCredentialDirectory(): void {
  const directory = credentialDirectory()
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(directory)) {
    if (entry.startsWith(CREDENTIAL_PREFIX)) fs.rmSync(path.join(directory, entry), { force: true })
  }
}

export async function withGithubAppGitCredentials<T>(
  repository: string,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const token = await installationToken(repository)
  const credentialFile = path.join(credentialDirectory(), `${CREDENTIAL_PREFIX}${randomUUID()}`)
  let fd: number | null = null
  try {
    fd = fs.openSync(credentialFile, 'wx', 0o600)
    fs.writeFileSync(fd, `https://x-access-token:${encodeURIComponent(token)}@github.com\n`)
    fs.closeSync(fd)
    fd = null

    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of Object.keys(env)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name) || /^GIT_TRACE/.test(name)) delete env[name]
    }
    delete env.GIT_CONFIG_PARAMETERS
    delete env.GIT_ASKPASS
    delete env.GIT_SSH
    delete env.GIT_SSH_COMMAND
    delete env.GIT_SSH_VARIANT
    delete env.SSH_ASKPASS
    delete env.GIT_CURL_VERBOSE
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = os.devNull
    env.GIT_CONFIG_COUNT = '3'
    env.GIT_CONFIG_KEY_0 = 'credential.helper'
    env.GIT_CONFIG_VALUE_0 = ''
    env.GIT_CONFIG_KEY_1 = 'credential.helper'
    env.GIT_CONFIG_VALUE_1 = `!f() { if [ "$1" = get ]; then git credential-store --file=${shellQuote(credentialFile)} get; fi; }; f`
    env.GIT_CONFIG_KEY_2 = 'credential.interactive'
    env.GIT_CONFIG_VALUE_2 = 'false'
    return await run(env)
  } finally {
    try {
      if (fd != null) fs.closeSync(fd)
    } finally {
      fs.rmSync(credentialFile, { force: true })
    }
  }
}

export function __resetGithubAppGitCredentialsForTests(): void {
  installationIds.clear()
  installationTokens.clear()
}
