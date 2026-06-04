// Issue #35 (slice 4b.2) — shared structured-overrides surface.
//
// Extracted verbatim from `routes/catalog/PendingPurchasesPage.tsx`
// where it was introduced in 88a809a as the reviewer-facing editor
// for the 9-field `edited_structured_fields` override JSONB. Moving
// it into the canonical-product-row module is the prerequisite for
// the eventual `PendingPurchaseRowCard` → `CanonicalProductRow`
// migration (slice 4b.3); once that lands, the override panel has
// to live next to the row itself.
//
// The helpers (`readInitialDraftStructured`, `readParsedStructuredValue`,
// `buildStructuredOverridePayload`, `areStructuredOverridesEqual`) take
// a structural `ParsedStructuredValues` interface rather than the
// `PendingPurchaseRow` Zod type so other surfaces (`/catalog/review`,
// `/catalog/repricing`, …) can reuse this without depending on the
// pending-purchases data model. `PendingPurchaseRow` is structurally
// compatible — TypeScript widens it to the interface at the call site.

import type { JSX } from 'react'

import type { EditedStructuredFields } from '../../../shared/contracts/index.js'
import { Pill } from '../Pill.js'

// Mirrors the keys of `EditedStructuredFieldsSchema` in
// shared/contracts/api/. Defined locally rather than imported because
// the contract only exports the Zod schema + inferred type; inflating
// a const tuple just for key ordering felt heavier than this enum.
export type StructuredOverrideKey =
  | 'expectedCategory'
  | 'expectedSubcategory'
  | 'targetBrand'
  | 'targetGroupName'
  | 'targetPackCount'
  | 'targetSize'
  | 'targetStrainName'
  | 'targetVariantName'
  | 'targetVariantTab'

export const STRUCTURED_OVERRIDE_KEYS: readonly StructuredOverrideKey[] = [
  'expectedCategory',
  'expectedSubcategory',
  'targetBrand',
  'targetGroupName',
  'targetPackCount',
  'targetSize',
  'targetStrainName',
  'targetVariantName',
  'targetVariantTab',
]

// Minimal structural shape the helpers read from a row. `PendingPurchaseRow`
// satisfies this implicitly via structural typing; other surfaces can
// build a compatible adapter without dragging in the pending-purchases
// contract.
//
// Note the asymmetry between `targetStrain` (parser-side field on the
// row) and `targetStrainName` (the override key) — kept identical to the
// original site so the override payload shape stays byte-for-byte the
// same as what the PATCH route already accepts.
export interface ParsedStructuredValues {
  readonly editedStructuredFields?: EditedStructuredFields | null
  readonly expectedCategory: string | null
  readonly expectedSubcategory: string | null
  readonly targetBrand: string | null
  readonly targetGroupName: string | null
  readonly targetPackCount: number | null
  readonly targetSize: string | null
  readonly targetStrain: string | null
  readonly targetVariantName: string | null
  readonly targetVariantTab: string | null
}

export type StructuredOverrideDraft = Record<StructuredOverrideKey, string>

// Initial draft values for the structured-overrides panel. Each
// field is seeded with the EFFECTIVE value (override-when-present
// ?? parsed) so the input behaves as "edit in place." Pack count is
// rendered as a string so the same generic StructuredOverrideField
// can handle every key.
export function readInitialDraftStructured(
  item: ParsedStructuredValues,
): StructuredOverrideDraft {
  const o = item.editedStructuredFields ?? null
  const pickStr = (override: string | null | undefined, parsed: string | null): string => {
    if (override === null) return '' // explicit clear
    if (override === undefined) return parsed ?? ''
    return override
  }
  const overridePackCount =
    o && 'targetPackCount' in o ? (o.targetPackCount as number | null | undefined) : undefined
  return {
    expectedCategory: pickStr(o?.expectedCategory, item.expectedCategory),
    expectedSubcategory: pickStr(o?.expectedSubcategory, item.expectedSubcategory),
    targetBrand: pickStr(o?.targetBrand, item.targetBrand),
    targetGroupName: pickStr(o?.targetGroupName, item.targetGroupName),
    targetPackCount:
      overridePackCount === null
        ? ''
        : overridePackCount === undefined
          ? item.targetPackCount === null
            ? ''
            : String(item.targetPackCount)
          : String(overridePackCount),
    targetSize: pickStr(o?.targetSize, item.targetSize),
    targetStrainName: pickStr(o?.targetStrainName, item.targetStrain),
    targetVariantName: pickStr(o?.targetVariantName, item.targetVariantName),
    targetVariantTab: pickStr(o?.targetVariantTab, item.targetVariantTab),
  }
}

// Map an override key to its parsed (parser/LLM) value on the row.
// Used to decide whether a draft value represents an override or
// just mirrors the parsed value (no override needed).
export function readParsedStructuredValue(
  item: ParsedStructuredValues,
  key: StructuredOverrideKey,
): string {
  switch (key) {
    case 'expectedCategory':
      return (item.expectedCategory ?? '').trim()
    case 'expectedSubcategory':
      return (item.expectedSubcategory ?? '').trim()
    case 'targetBrand':
      return (item.targetBrand ?? '').trim()
    case 'targetGroupName':
      return (item.targetGroupName ?? '').trim()
    case 'targetPackCount':
      return item.targetPackCount === null ? '' : String(item.targetPackCount)
    case 'targetSize':
      return (item.targetSize ?? '').trim()
    case 'targetStrainName':
      return (item.targetStrain ?? '').trim()
    case 'targetVariantName':
      return (item.targetVariantName ?? '').trim()
    case 'targetVariantTab':
      return (item.targetVariantTab ?? '').trim()
  }
}

// Build the full structured-overrides payload that the PATCH route
// expects. The route does a FULL replace when `editedStructuredFields`
// is present, so we always send a complete desired override map:
//   - draft == parsed       → key omitted (no override)
//   - draft != parsed       → key present with the new value
//   - draft empty (parsed nonempty) → key present as `null` to clear
// Returns `null` when no fields are overridden so the route can
// store a NULL column.
export function buildStructuredOverridePayload(
  item: ParsedStructuredValues,
  draft: StructuredOverrideDraft,
): EditedStructuredFields | null {
  const result: Record<string, string | number | null> = {}
  let anyOverride = false
  for (const key of STRUCTURED_OVERRIDE_KEYS) {
    const parsed = readParsedStructuredValue(item, key)
    const draftValue = draft[key].trim()
    if (draftValue === parsed) {
      continue
    }
    if (draftValue === '') {
      // Reviewer explicitly cleared a field that the parser had populated.
      result[key] = null
      anyOverride = true
      continue
    }
    if (key === 'targetPackCount') {
      const n = Number.parseInt(draftValue, 10)
      if (!Number.isInteger(n) || n <= 0 || n > 1000) {
        // Invalid input — skip rather than emit garbage; the user
        // sees no diff so they'll notice their input was ignored.
        continue
      }
      result[key] = n
      anyOverride = true
      continue
    }
    result[key] = draftValue
    anyOverride = true
  }
  if (!anyOverride) {
    return null
  }
  return result as EditedStructuredFields
}

// Cheap structural equality on the override map for change-detection.
// Treats `null` and `{}` as the SAME state (= "no overrides at all"),
// matching how the server normalises the column on read.
export function areStructuredOverridesEqual(
  a: EditedStructuredFields | null,
  b: EditedStructuredFields | null,
): boolean {
  const aNorm = a && Object.keys(a).length === 0 ? null : a
  const bNorm = b && Object.keys(b).length === 0 ? null : b
  if (aNorm === bNorm) return true
  if (aNorm === null || bNorm === null) return false
  const aKeys = Object.keys(aNorm).sort()
  const bKeys = Object.keys(bNorm).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false
  }
  for (const k of aKeys) {
    if ((aNorm as Record<string, unknown>)[k] !== (bNorm as Record<string, unknown>)[k]) {
      return false
    }
  }
  return true
}

// Subset of `StructuredOverrideKey` that resolves to a string-typed
// effective value. Excludes `targetPackCount` which has its own
// numeric accessor below.
export type StructuredOverrideStringKey = Exclude<StructuredOverrideKey, 'targetPackCount'>

// Returns the EFFECTIVE value for a structured field — i.e. the
// reviewer override when one is present (including explicit
// `null` for "cleared"), otherwise the parser-side value. Mirrors
// `pickEffectiveString` in
// `worker/jobs/applyPendingPurchaseRequestJob.ts` so the row card
// display reflects exactly what apply would write to Sweed.
export function effectiveStructured(
  item: ParsedStructuredValues,
  key: StructuredOverrideStringKey,
): string | null {
  const o = item.editedStructuredFields
  if (o && key in o) {
    const v = (o as Record<string, unknown>)[key]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  // The override-side key for strain is `targetStrainName`; the
  // parser-side row field is `targetStrain` (kept as-is to avoid
  // churning every consumer of PendingPurchaseRow).
  if (key === 'targetStrainName') return item.targetStrain
  return (item as unknown as Record<string, string | null>)[key]
}

export function effectiveStructuredPackCount(item: ParsedStructuredValues): number | null {
  const o = item.editedStructuredFields
  if (o && 'targetPackCount' in o) {
    const v = (o as Record<string, unknown>).targetPackCount
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
  }
  return item.targetPackCount
}

// Whether the reviewer has explicitly set this key in the JSONB
// override map. Drives the amber `value-panel--overridden`
// background + "edited" pill on display cells in the row-card
// Product Hierarchy grid (issue #35).
export function hasStructuredOverride(
  item: ParsedStructuredValues,
  key: StructuredOverrideKey,
): boolean {
  const o = item.editedStructuredFields
  if (!o) return false
  return key in o
}

// Reviewer-facing input for a single structured-override key.
// Pre-populated with the effective merged value; the parser's
// original value is shown as a `parser: ...` hint and an "override"
// pill appears when the reviewer diverges from the parsed value.
//
// When `options` is supplied the field renders as a `<select>` rather
// than a freeform `<input>` — used for brand / category / subcategory
// where every legitimate value already exists somewhere in
// `catalog_groups` and freeform typing produces avoidable typos /
// near-duplicates that fragment the catalog. The current value is
// always appended to the dropdown (even if it isn't in the canonical
// list) so the operator can still see and re-pick exotic LLM-proposed
// values without losing them.
export function StructuredOverrideField({
  disabled,
  inputMode,
  label,
  noneLabel,
  onChange,
  options,
  parsedValue,
  value,
}: {
  disabled: boolean
  inputMode?: 'numeric'
  label: string
  // When supplied (only meaningful for `<select>` fields whose value is
  // legitimately optional, e.g. subcategory), the empty "" entry renders
  // with this explicit label instead of the "inherit"/"—" default — so
  // the reviewer can deliberately choose "no value" rather than being led
  // to believe the empty entry keeps the parser's proposal.
  noneLabel?: string
  onChange: (value: string) => void
  options?: readonly string[]
  parsedValue: string | null
  value: string
}): JSX.Element {
  const trimmed = value.trim()
  const parsedTrimmed = (parsedValue ?? '').trim()
  const isOverridden = trimmed !== parsedTrimmed
  return (
    <label className="stack-field">
      <span>
        {label}
        {isOverridden ? <Pill tone="warning">override</Pill> : null}
      </span>
      {options !== undefined ? (
        <StructuredOverrideSelect
          disabled={disabled}
          noneLabel={noneLabel}
          onChange={onChange}
          options={options}
          parsedValue={parsedValue}
          value={value}
        />
      ) : (
        <input
          disabled={disabled}
          inputMode={inputMode}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={parsedValue ?? '—'}
          value={value}
        />
      )}
      {isOverridden && parsedValue !== null ? (
        <span className="subtle-copy">parser: {parsedValue}</span>
      ) : null}
    </label>
  )
}

function StructuredOverrideSelect({
  disabled,
  noneLabel,
  onChange,
  options,
  parsedValue,
  value,
}: {
  disabled: boolean
  noneLabel?: string
  onChange: (value: string) => void
  options: readonly string[]
  parsedValue: string | null
  value: string
}): JSX.Element {
  // Build the option list:
  //   1. Always include the empty "" entry. Selecting it sets the draft
  //      to "" which `buildStructuredOverridePayload` translates to
  //      "no value" — either omit-key (when the parser also proposed
  //      nothing) or an explicit `null` clear (when the parser proposed
  //      a value the reviewer wants gone). For optional fields like
  //      subcategory, callers pass `noneLabel` (e.g. "— No subcategory —")
  //      so this entry is unmistakably a "set to none" action rather
  //      than the misleading "inherit the parser's value" it used to
  //      read as. To KEEP a parser-proposed value, the reviewer picks
  //      that value from the list (it is always present, see #2).
  //   2. Always include the parser-proposed value (when nonempty),
  //      even if it isn't in the canonical facet list — otherwise a
  //      brand-new brand the LLM teacher proposed would silently
  //      disappear from the dropdown the moment the operator opened
  //      the editor.
  //   3. Always include the current draft `value` for the same reason
  //      (e.g. a previously-saved override pointing at a since-deleted
  //      brand).
  //   4. Then the canonical options list, de-duplicated and sorted.
  const augmented = new Set<string>()
  if (parsedValue && parsedValue.trim().length > 0) augmented.add(parsedValue.trim())
  if (value && value.trim().length > 0) augmented.add(value.trim())
  for (const option of options) {
    const trimmed = option.trim()
    if (trimmed.length > 0) augmented.add(trimmed)
  }
  const sorted = [...augmented].sort((left, right) => left.localeCompare(right))
  return (
    <select
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      <option value="">
        {noneLabel ?? (parsedValue ? `— inherit (${parsedValue}) —` : '—')}
      </option>
      {sorted.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
}
