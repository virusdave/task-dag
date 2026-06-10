import { useCallback, useMemo, useState } from 'react'

import {
  WAREHOUSE_LOCATION_PREFIXES,
  WarehouseLocationAssignResponseSchema,
  isValidWarehouseLocationCode,
  type WarehouseLocationAssignResponse,
  type WarehouseLocationPrefix,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'

/* -------------------------------------------------------------------------- *
 *  Shared warehouse "shelf location" picker + assign helper.                   *
 *                                                                            *
 *  A shelf-location code is PREFIX-COLUMN-ROW[-split] (e.g. EDI-A-4,           *
 *  PRE-A-3-b). The same picker + POST /api/warehouse-locations/assign client   *
 *  are reused by the dedicated Warehouse Locations packing page AND by the     *
 *  per-package "Set shelf" action on the Images & Barcodes page, so the two    *
 *  never drift. Keep this module presentational/transport-only; page-specific  *
 *  flow (traversal stepper, conflict copy, session history) stays in the       *
 *  pages.                                                                      *
 * -------------------------------------------------------------------------- */

export const SPLIT_OPTIONS = ['', 'a', 'b', 'c', 'd', 'e', 'f'] as const

export interface AssignBody {
  locationCode: string
  source: 'shelf-scan' | 'audit' | 'images-page'
  scannedCode?: string
  inventoryItemId?: string
  allowReassign?: boolean
}

export type AssignOutcome =
  | { ok: true; data: WarehouseLocationAssignResponse }
  // `status` carries the HTTP status when the failure came from the server
  // (so callers can show friendly copy for 5xx vs. surface the raw 4xx
  // message). It is undefined for a client-side transport/parse failure that
  // never reached the server.
  | { ok: false; error: string; status?: number }

export async function postAssign(body: AssignBody): Promise<AssignOutcome> {
  try {
    const response = await fetch(buildAppPath('/api/warehouse-locations/assign'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const error = await readError(response)
      return { ok: false, error, status: response.status }
    }
    const data = WarehouseLocationAssignResponseSchema.parse(await response.json())
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (typeof payload.error === 'string' && payload.error.length > 0) return payload.error
  } catch {
    /* fall through */
  }
  return `${response.status} ${response.statusText}`
}

/** Assemble a valid shelf code from picker parts, or null if incomplete. */
export function buildCode(
  prefix: WarehouseLocationPrefix | null,
  column: string,
  row: number,
  split: string,
): string | null {
  if (!prefix) return null
  if (!/^[A-Z]$/.test(column)) return null
  if (!Number.isInteger(row) || row < 1) return null
  const code = `${prefix}-${column}-${row}${split ? `-${split}` : ''}`
  return isValidWarehouseLocationCode(code) ? code : null
}

/** Compact METRC-tag label for tight mobile rows (last 6 chars). */
export function metrcSuffix(tag: string | null): string {
  if (!tag) return '—'
  const cleaned = tag.replace(/\s+/g, '')
  return cleaned.length <= 6 ? cleaned : `…${cleaned.slice(-6)}`
}

export interface LocationPickerProps {
  prefix: WarehouseLocationPrefix | null
  column: string
  row: number
  split: string
  onPrefix: (p: WarehouseLocationPrefix) => void
  onColumn: (c: string) => void
  onRow: (r: number) => void
  onSplit: (s: string) => void
}

export function LocationPicker(props: LocationPickerProps) {
  const { prefix, column, row, split, onPrefix, onColumn, onRow, onSplit } = props
  const shiftColumn = (delta: number) => {
    const next = String.fromCharCode(Math.min(90, Math.max(65, column.charCodeAt(0) + delta)))
    // Don't fire (and reset row/split) when already clamped at A/Z.
    if (next !== column) onColumn(next)
  }
  const shiftRow = (next: number) => {
    if (next !== row) onRow(next)
  }
  return (
    <div className="wh-picker">
      <div className="wh-picker-row">
        <span className="wh-picker-label">Category</span>
        <div className="inline-row wrap-row wh-chip-row">
          {WAREHOUSE_LOCATION_PREFIXES.map((entry) => (
            <button
              key={entry.prefix}
              type="button"
              className={`ghost-button wh-chip${prefix === entry.prefix ? ' is-active' : ''}`}
              onClick={() => onPrefix(entry.prefix)}
              title={entry.label}
            >
              {entry.prefix}
            </button>
          ))}
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Column</span>
        <div className="wh-stepper">
          <button type="button" className="ghost-button wh-step-btn" onClick={() => shiftColumn(-1)} aria-label="Previous column">
            −
          </button>
          <span className="wh-step-value">{column}</span>
          <button type="button" className="ghost-button wh-step-btn" onClick={() => shiftColumn(1)} aria-label="Next column">
            +
          </button>
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Row</span>
        <div className="wh-stepper">
          <button
            type="button"
            className="ghost-button wh-step-btn"
            onClick={() => shiftRow(Math.max(1, row - 1))}
            aria-label="Previous row"
          >
            −
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            className="wh-row-input"
            value={row}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10)
              onRow(Number.isInteger(next) && next >= 1 ? next : 1)
            }}
          />
          <button type="button" className="ghost-button wh-step-btn" onClick={() => shiftRow(row + 1)} aria-label="Next row">
            +
          </button>
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Bin split</span>
        <div className="inline-row wrap-row wh-chip-row">
          {SPLIT_OPTIONS.map((option) => (
            <button
              key={option || 'none'}
              type="button"
              className={`ghost-button wh-chip${split === option ? ' is-active' : ''}`}
              onClick={() => onSplit(option)}
            >
              {option === '' ? 'none' : option}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Parse a valid shelf code back into picker parts (for initializing the picker
 *  to a package's current shelf). Returns null for codes that don't parse. */
export function parseCode(
  code: string | null,
): { prefix: WarehouseLocationPrefix; column: string; row: number; split: string } | null {
  if (!code || !isValidWarehouseLocationCode(code)) return null
  const m = code.trim().match(/^([A-Z]{3})-([A-Z])-([1-9][0-9]*)(?:-([a-z]))?$/)
  if (!m) return null
  return {
    prefix: m[1] as WarehouseLocationPrefix,
    column: m[2]!,
    row: Number.parseInt(m[3]!, 10),
    split: m[4] ?? '',
  }
}

/** The next bin-split letter (a → b → … → z), or null past the alphabet / when
 *  the row isn't split. Drives the warehouse page's "advance to next" stepper. */
export function nextSplit(current: string): string | null {
  if (current === '') return 'a'
  if (current.length === 1 && current >= 'a' && current < 'z') {
    return String.fromCharCode(current.charCodeAt(0) + 1)
  }
  return null
}

export interface LocationPickerState {
  prefix: WarehouseLocationPrefix | null
  column: string
  row: number
  split: string
  code: string | null
  setPrefix: (p: WarehouseLocationPrefix) => void
  changeColumn: (c: string) => void
  changeRow: (r: number) => void
  setSplit: (s: string) => void
  advance: () => void
}

/**
 * Shared prefix/column/row/split state for every shelf picker (warehouse
 * shelf-run, warehouse audit, and the Images & Barcodes "Set shelf" editor),
 * with the operator's traversal rules baked in:
 *   - changing the COLUMN starts a fresh column → row 1, no bin split;
 *   - changing the ROW keeps you in split mode but jumps to the first bin →
 *     if a split was set it returns to 'a', otherwise it stays none;
 *   - `advance` ("next location") walks the bin-split letters when the row is
 *     split (a → b → …), otherwise steps to the next row. Exhausting the
 *     letters rolls to the next row, restarting at bin 'a'.
 *
 * `initialCode` seeds the picker from a package's existing shelf (used by the
 * "Change shelf" editor); it is read once at mount, so re-opening the editor
 * for a different package must remount the component (a stable React `key`).
 */
export function useLocationPickerState(initialCode?: string | null): LocationPickerState {
  // Seed once at mount from the package's current shelf (if any). Lazy
  // initializers keep `parseCode` from running on every render.
  const [prefix, setPrefix] = useState<WarehouseLocationPrefix | null>(
    () => parseCode(initialCode ?? null)?.prefix ?? null,
  )
  const [column, setColumn] = useState(() => parseCode(initialCode ?? null)?.column ?? 'A')
  const [row, setRow] = useState(() => parseCode(initialCode ?? null)?.row ?? 1)
  const [split, setSplit] = useState(() => parseCode(initialCode ?? null)?.split ?? '')

  const changeColumn = useCallback((c: string) => {
    setColumn(c)
    setRow(1)
    setSplit('')
  }, [])

  const changeRow = useCallback((r: number) => {
    setRow(r)
    setSplit((s) => (s === '' ? '' : 'a'))
  }, [])

  const advance = useCallback(() => {
    if (split === '') {
      setRow((r) => r + 1)
      return
    }
    const next = nextSplit(split)
    if (next) {
      setSplit(next)
    } else {
      setRow((r) => r + 1)
      setSplit('a')
    }
  }, [split])

  const code = useMemo(() => buildCode(prefix, column, row, split), [prefix, column, row, split])

  return { prefix, column, row, split, code, setPrefix, changeColumn, changeRow, setSplit, advance }
}
