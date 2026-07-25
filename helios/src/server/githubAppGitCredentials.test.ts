import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetGithubAppGitCredentialsForTests,
  prepareGithubAppGitCredentialDirectory,
  withGithubAppGitCredentials,
} from './githubAppGitCredentials.js'

let root: string
let keyFile: string
let credentialDir: string
let publicKey: KeyObject

function githubResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-git-'))
  keyFile = path.join(root, 'app.pem')
  credentialDir = path.join(root, 'credentials')
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const { privateKey } = keyPair
  publicKey = keyPair.publicKey
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  process.env.HELIOS_GITHUB_APP_ID = '12345'
  process.env.HELIOS_GITHUB_APP_PRIVATE_KEY_FILE = keyFile
  process.env.HELIOS_GITHUB_APP_CREDENTIAL_DIR = credentialDir
})

beforeEach(() => {
  __resetGithubAppGitCredentialsForTests()
  fs.mkdirSync(credentialDir, { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const entry of fs.readdirSync(credentialDir)) fs.rmSync(path.join(credentialDir, entry), { force: true })
})

afterAll(() => {
  delete process.env.HELIOS_GITHUB_APP_ID
  delete process.env.HELIOS_GITHUB_APP_PRIVATE_KEY_FILE
  delete process.env.HELIOS_GITHUB_APP_CREDENTIAL_DIR
  fs.rmSync(root, { recursive: true, force: true })
})

describe('GitHub App Git credentials', () => {
  it('mints, caches, confines, and cleans up a repository-scoped read token', async () => {
    const injectedHelperMarker = path.join(root, 'injected-helper-ran')
    process.env.GIT_CONFIG_PARAMETERS = `'credential.helper=!touch ${injectedHelperMarker}'`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(githubResponse({ id: 987 }))
      .mockResolvedValueOnce(githubResponse({
        token: 'installation-secret',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }))
    vi.stubGlobal('fetch', fetchMock)

    let credentialFile = ''
    await withGithubAppGitCredentials('FreshlyBakedNYC/automation', async (env) => {
      credentialFile = env.GIT_CONFIG_VALUE_1!.match(/--file='([^']+)'/)![1]
      expect(env.GIT_CONFIG_COUNT).toBe('3')
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
      expect(env.GIT_CONFIG_VALUE_0).toBe('')
      expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper')
      expect(env.GIT_CONFIG_KEY_2).toBe('credential.interactive')
      expect(env.GIT_CONFIG_VALUE_2).toBe('false')
      expect(env.GIT_SSH_COMMAND).toBeUndefined()
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined()
      expect(Object.values(env)).not.toContain('installation-secret')
      expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(credentialFile, 'utf8'))
        .toBe('https://x-access-token:installation-secret@github.com\n')

      const filled = execFileSync('git', ['credential', 'fill'], {
        env,
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
      })
      expect(filled).toContain('username=x-access-token')
      expect(filled).toContain('password=installation-secret')
      execFileSync('git', ['credential', 'approve'], {
        env,
        input: 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=installation-secret\n\n',
      })
      expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600)
      expect(fs.existsSync(injectedHelperMarker)).toBe(false)
    })
    delete process.env.GIT_CONFIG_PARAMETERS
    expect(fs.existsSync(credentialFile)).toBe(false)

    await withGithubAppGitCredentials('FreshlyBakedNYC/automation', async () => undefined)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/FreshlyBakedNYC/automation/installation')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/app/installations/987/access_tokens')
    const tokenRequest = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(tokenRequest.body))).toEqual({
      repositories: ['automation'],
      permissions: { contents: 'read' },
    })

    const installationRequest = fetchMock.mock.calls[0][1] as RequestInit
    const authorization = new Headers(installationRequest.headers).get('Authorization')!
    const jwt = authorization.replace('Bearer ', '')
    const [encodedHeader, encodedClaims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString()) as {
      iat: number
      exp: number
      iss: string
    }
    expect(claims.iss).toBe('12345')
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60)
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${encodedHeader}.${encodedClaims}`)
    verifier.end()
    expect(verifier.verify(publicKey, signature, 'base64url')).toBe(true)
  })

  it('refreshes a token inside the expiry skew while retaining the installation id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(githubResponse({ id: 987 }))
      .mockResolvedValueOnce(githubResponse({
        token: 'expiring-token',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }))
      .mockResolvedValueOnce(githubResponse({
        token: 'fresh-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }))
    vi.stubGlobal('fetch', fetchMock)

    await withGithubAppGitCredentials('FreshlyBakedNYC/top-level', async () => undefined)
    await withGithubAppGitCredentials('FreshlyBakedNYC/top-level', async (env) => {
      const credentialFile = env.GIT_CONFIG_VALUE_1!.match(/--file='([^']+)'/)![1]
      expect(fs.readFileSync(credentialFile, 'utf8')).toContain('fresh-token')
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('cleans credentials after callback rejection and at startup', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(githubResponse({ id: 987 }))
      .mockResolvedValueOnce(githubResponse({
        token: 'installation-secret',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })))
    let credentialFile = ''
    await expect(withGithubAppGitCredentials('FreshlyBakedNYC/nixos-sbc', async (env) => {
      credentialFile = env.GIT_CONFIG_VALUE_1!.match(/--file='([^']+)'/)![1]
      throw new Error('git failed')
    })).rejects.toThrow('git failed')
    expect(fs.existsSync(credentialFile)).toBe(false)

    fs.writeFileSync(path.join(credentialDir, '.github-credential-stale'), 'expired')
    fs.writeFileSync(path.join(credentialDir, 'keep-me'), 'unrelated')
    prepareGithubAppGitCredentialDirectory()
    expect(fs.existsSync(path.join(credentialDir, '.github-credential-stale'))).toBe(false)
    expect(fs.existsSync(path.join(credentialDir, 'keep-me'))).toBe(true)
  })

  it('does not expose a GitHub rejection response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubResponse({
      message: 'secret-bearing remote diagnostic',
    }, 403)))
    await expect(withGithubAppGitCredentials('FreshlyBakedNYC/private', async () => undefined))
      .rejects.toThrow('GitHub App request /repos/FreshlyBakedNYC/private/installation failed with HTTP 403')
    await expect(withGithubAppGitCredentials('FreshlyBakedNYC/private', async () => undefined))
      .rejects.not.toThrow('secret-bearing remote diagnostic')
  })

  it('removes the credential file when writing it fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(githubResponse({ id: 987 }))
      .mockResolvedValueOnce(githubResponse({
        token: 'installation-secret',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })))
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('simulated credential write failure')
    })
    await expect(withGithubAppGitCredentials('FreshlyBakedNYC/write-failure', async () => undefined))
      .rejects.toThrow('simulated credential write failure')
    write.mockRestore()
    expect(fs.readdirSync(credentialDir).filter((entry) => entry.startsWith('.github-credential-'))).toEqual([])
  })
})
