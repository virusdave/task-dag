import { describe, expect, it } from 'vitest'

import type { PendingMigration } from '../../shared/contracts/index.js'
import {
  DISMISSED_SIGNATURE_STORAGE_KEY,
  buildPendingMigrationsSignature,
  clearDismissedSignature,
  getPendingMigrationsBannerMode,
  readDismissedSignature,
  writeDismissedSignature,
  type SignatureStorage,
} from './pendingMigrationsBannerState.js'

function migration(migrationId: string): PendingMigration {
  return { migrationId, label: `label-${migrationId}` }
}

// Minimal in-memory Storage stand-in for the read/write/clear helpers.
function fakeStorage(initial: Record<string, string> = {}): SignatureStorage & {
  dump: () => Record<string, string>
} {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
    dump: () => Object.fromEntries(map),
  }
}

// A storage whose every method throws, to prove the helpers fail safe.
const throwingStorage: SignatureStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
  removeItem: () => {
    throw new Error('blocked')
  },
}

describe('buildPendingMigrationsSignature', () => {
  it('returns null when nothing is pending', () => {
    expect(buildPendingMigrationsSignature([])).toBeNull()
  })

  it('is stable regardless of API ordering', () => {
    const a = buildPendingMigrationsSignature([migration('003'), migration('001'), migration('002')])
    const b = buildPendingMigrationsSignature([migration('001'), migration('002'), migration('003')])
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it('differs when the set changes', () => {
    const one = buildPendingMigrationsSignature([migration('001')])
    const two = buildPendingMigrationsSignature([migration('001'), migration('002')])
    expect(one).not.toBe(two)
  })

  it('only depends on migrationId, not label', () => {
    const base = buildPendingMigrationsSignature([migration('001')])
    const renamed = buildPendingMigrationsSignature([
      { migrationId: '001', label: 'totally different' },
    ])
    expect(base).toBe(renamed)
  })
})

describe('getPendingMigrationsBannerMode', () => {
  it('hidden when there is no pending signature', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: null,
        dismissedSignature: null,
        manuallyExpandedSignature: null,
      }),
    ).toBe('hidden')
  })

  it('expanded for a never-dismissed pending set', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: 'sig-A',
        dismissedSignature: null,
        manuallyExpandedSignature: null,
      }),
    ).toBe('expanded')
  })

  it('collapsed when the current set matches the dismissed signature', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: 'sig-A',
        dismissedSignature: 'sig-A',
        manuallyExpandedSignature: null,
      }),
    ).toBe('collapsed')
  })

  it('re-expands when a new/different set appears after a dismissal', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: 'sig-B',
        dismissedSignature: 'sig-A',
        manuallyExpandedSignature: null,
      }),
    ).toBe('expanded')
  })

  it('expands when the user taps the pill to peek at the dismissed set', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: 'sig-A',
        dismissedSignature: 'sig-A',
        manuallyExpandedSignature: 'sig-A',
      }),
    ).toBe('expanded')
  })

  it('a stale manual-expand of a different signature does not force expand', () => {
    expect(
      getPendingMigrationsBannerMode({
        signature: 'sig-A',
        dismissedSignature: 'sig-A',
        manuallyExpandedSignature: 'sig-OLD',
      }),
    ).toBe('collapsed')
  })
})

describe('signature storage helpers', () => {
  it('round-trips a signature through storage', () => {
    const storage = fakeStorage()
    writeDismissedSignature(storage, 'sig-A')
    expect(storage.dump()).toEqual({ [DISMISSED_SIGNATURE_STORAGE_KEY]: 'sig-A' })
    expect(readDismissedSignature(storage)).toBe('sig-A')
  })

  it('reads null when nothing was stored', () => {
    expect(readDismissedSignature(fakeStorage())).toBeNull()
  })

  it('clears the stored signature', () => {
    const storage = fakeStorage({ [DISMISSED_SIGNATURE_STORAGE_KEY]: 'sig-A' })
    clearDismissedSignature(storage)
    expect(readDismissedSignature(storage)).toBeNull()
  })

  it('treats a null storage (no browser storage) as not dismissed', () => {
    expect(readDismissedSignature(null)).toBeNull()
    // Should not throw:
    writeDismissedSignature(null, 'sig-A')
    clearDismissedSignature(null)
  })

  it('fails safe to not-dismissed when storage throws', () => {
    expect(readDismissedSignature(throwingStorage)).toBeNull()
    // Write/clear must swallow the throw rather than crash the banner.
    expect(() => writeDismissedSignature(throwingStorage, 'sig-A')).not.toThrow()
    expect(() => clearDismissedSignature(throwingStorage)).not.toThrow()
  })
})
