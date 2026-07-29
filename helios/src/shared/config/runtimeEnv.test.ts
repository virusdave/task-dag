import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  extractEnvAssignmentValue,
  extractPostgresUrl,
  readOptionalSecretEnv,
  readRequiredReadOnlyDatabaseUrl,
  validateReadOnlyDatabaseUrl,
} from './runtimeEnv.js'

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

describe('readRequiredReadOnlyDatabaseUrl', () => {
  it('reads the dedicated URL without falling back to DATABASE_URL', () => {
    const previousReadOnly = process.env.HELIOS_READONLY_DATABASE_URL
    const previousDatabase = process.env.DATABASE_URL
    process.env.HELIOS_READONLY_DATABASE_URL =
      'postgres://helios_agent_readonly:secret@db.example.com/tsdb'
    process.env.DATABASE_URL = 'postgres://writer:secret@db.example.com/helios'

    try {
      expect(readRequiredReadOnlyDatabaseUrl()).toBe(
        'postgres://helios_agent_readonly:secret@db.example.com/tsdb',
      )
    } finally {
      if (previousReadOnly === undefined) delete process.env.HELIOS_READONLY_DATABASE_URL
      else process.env.HELIOS_READONLY_DATABASE_URL = previousReadOnly
      if (previousDatabase === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabase
    }
  })

  it('rejects a write-capable identity stored under the read-only name', () => {
    expect(() =>
      validateReadOnlyDatabaseUrl('postgres://tsdbadmin:secret@db.example.com/tsdb'),
    ).toThrow('must authenticate as helios_agent_readonly against /tsdb')
  })

  it('rejects the read-only identity pointed at another database', () => {
    expect(() =>
      validateReadOnlyDatabaseUrl(
        'postgres://helios_agent_readonly:secret@db.example.com/postgres',
      ),
    ).toThrow('must authenticate as helios_agent_readonly against /tsdb')
  })

  it('fails closed when only the write-capable URL is configured', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'helios-readonly-env-'))
    const previousReadOnly = process.env.HELIOS_READONLY_DATABASE_URL
    const previousReadOnlyFile = process.env.HELIOS_READONLY_DATABASE_URL_FILE
    const previousDatabase = process.env.DATABASE_URL
    const previousHome = process.env.HOME
    delete process.env.HELIOS_READONLY_DATABASE_URL
    delete process.env.HELIOS_READONLY_DATABASE_URL_FILE
    process.env.DATABASE_URL = 'postgres://writer:secret@db.example.com/helios'
    process.env.HOME = tempHome

    try {
      expect(() => readRequiredReadOnlyDatabaseUrl()).toThrow(
        'The read-only loader never falls back to DATABASE_URL.',
      )
    } finally {
      if (previousReadOnly === undefined) delete process.env.HELIOS_READONLY_DATABASE_URL
      else process.env.HELIOS_READONLY_DATABASE_URL = previousReadOnly
      if (previousReadOnlyFile === undefined) delete process.env.HELIOS_READONLY_DATABASE_URL_FILE
      else process.env.HELIOS_READONLY_DATABASE_URL_FILE = previousReadOnlyFile
      if (previousDatabase === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabase
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(tempHome, { force: true, recursive: true })
    }
  })
})
