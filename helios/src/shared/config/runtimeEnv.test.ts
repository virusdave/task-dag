import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractEnvAssignmentValue, extractPostgresUrl, readOptionalSecretEnv } from './runtimeEnv.js'

describe('extractPostgresUrl', () => {
  it('extracts the first postgres url from TigerData-style credential text', () => {
    const credentialsText = `
SERVICE INFORMATION
Service URL: postgres://tsdbadmin:secret@db.example.tsdb.cloud.timescale.com:30667/tsdb?sslmode=require
Port: 30667

CONNECT TO YOUR SERVICE
psql "postgres://tsdbadmin:secret@db.example.tsdb.cloud.timescale.com:30667/tsdb?sslmode=require"
`

    expect(extractPostgresUrl(credentialsText)).toBe(
      'postgres://tsdbadmin:secret@db.example.tsdb.cloud.timescale.com:30667/tsdb?sslmode=require',
    )
  })

  it('returns null when the credentials text does not contain a postgres url', () => {
    expect(extractPostgresUrl('host=db.example.com\nport=5432')).toBeNull()
  })
})

describe('extractEnvAssignmentValue', () => {
  it('extracts raw values from shell export helpers', () => {
    const contents = 'export BEDROCK_MANTLE_BEARER_TOKEN=super-secret-token\n'

    expect(extractEnvAssignmentValue(contents, 'BEDROCK_MANTLE_BEARER_TOKEN')).toBe('super-secret-token')
  })

  it('extracts quoted values and ignores inline comments', () => {
    const contents = 'GOOGLE_OAUTH_REDIRECT_URI="https://catalog.example.com/api/auth/google/callback" # current callback\n'

    expect(extractEnvAssignmentValue(contents, 'GOOGLE_OAUTH_REDIRECT_URI')).toBe(
      'https://catalog.example.com/api/auth/google/callback',
    )
  })
})

describe('readOptionalSecretEnv', () => {
  it('reads named values from .env helper files', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'catalog-curation-runtime-env-'))
    const helperFile = join(tempDirectory, 'catalog-curation.env')
    writeFileSync(helperFile, 'GOOGLE_OAUTH_CLIENT_ID=test-client-id\n', 'utf8')

    const previousValue = process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_ID

    try {
      expect(
        readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_ID', {
          defaultFilePaths: [helperFile],
        }),
      ).toBe('test-client-id')
    } finally {
      if (previousValue === undefined) {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID
      } else {
        process.env.GOOGLE_OAUTH_CLIENT_ID = previousValue
      }
      rmSync(tempDirectory, { force: true, recursive: true })
    }
  })

  it('reads Google OAuth values from the standard client JSON secret file', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'catalog-curation-runtime-env-'))
    const helperFile = join(tempDirectory, 'client')
    writeFileSync(
      helperFile,
      JSON.stringify({
        web: {
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          redirect_uris: ['https://freshlybaked.nyc/internal/tools/helios/api/auth/google/callback'],
        },
      }),
      'utf8',
    )

    const previousClientId = process.env.GOOGLE_OAUTH_CLIENT_ID
    const previousClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    const previousRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI

    try {
      expect(
        readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_ID', {
          defaultFilePaths: [helperFile],
        }),
      ).toBe('test-client-id')
      expect(
        readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_SECRET', {
          defaultFilePaths: [helperFile],
        }),
      ).toBe('test-client-secret')
      expect(
        readOptionalSecretEnv('GOOGLE_OAUTH_REDIRECT_URI', {
          defaultFilePaths: [helperFile],
        }),
      ).toBe('https://freshlybaked.nyc/internal/tools/helios/api/auth/google/callback')
    } finally {
      if (previousClientId === undefined) {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID
      } else {
        process.env.GOOGLE_OAUTH_CLIENT_ID = previousClientId
      }

      if (previousClientSecret === undefined) {
        delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
      } else {
        process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousClientSecret
      }

      if (previousRedirectUri === undefined) {
        delete process.env.GOOGLE_OAUTH_REDIRECT_URI
      } else {
        process.env.GOOGLE_OAUTH_REDIRECT_URI = previousRedirectUri
      }

      rmSync(tempDirectory, { force: true, recursive: true })
    }
  })

  it('ignores unrelated .env helper files instead of treating them as raw secret values', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'catalog-curation-runtime-env-'))
    const helperFile = join(tempDirectory, 'catalog-curation.env')
    writeFileSync(helperFile, 'GOOGLE_OAUTH_CLIENT_SECRET=test-client-secret\n', 'utf8')

    const previousValue = process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_ID

    try {
      expect(
        readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_ID', {
          defaultFilePaths: [helperFile],
        }),
      ).toBeNull()
    } finally {
      if (previousValue === undefined) {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID
      } else {
        process.env.GOOGLE_OAUTH_CLIENT_ID = previousValue
      }
      rmSync(tempDirectory, { force: true, recursive: true })
    }
  })
})
