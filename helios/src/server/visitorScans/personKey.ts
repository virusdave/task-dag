// Derives a stable, normalised key that groups visitor_scans rows
// belonging to the same physical person without requiring a Sweed
// CRM match.
//
// Used in two places:
//
//   1. The Node insert helper in
//      helios/src/server/db/queries/visitorScansQueries.ts persists
//      this key on every new row.
//
//   2. Migration 040 backfills the same key on existing rows via an
//      identical SQL concat — keep the two implementations in
//      lock-step.
//
// Concretely we lower-case + collapse whitespace on `first + last`,
// pin to ISO birth_date, upper-case the state, and slice the zip5
// off any postal code. The bar for inclusion in the key is "fields
// that a returning customer carrying the same driver's licence
// would re-emit identically" — name + DOB + state + zip5 hits that
// bar. Address line and city are intentionally omitted (apartment
// numbers change; zip5 catches the move-across-town case).

function normaliseName(first: string | null, last: string | null): string | null {
  const combined = `${first ?? ''} ${last ?? ''}`.trim()
  if (combined.length === 0) return null
  const lower = combined.toLowerCase()
  const collapsed = lower.replace(/\s+/g, ' ')
  return collapsed
}

function normaliseBirthDate(birthDate: string | null): string {
  if (birthDate === null) return ''
  const trimmed = birthDate.trim()
  if (trimmed.length === 0) return ''
  // The wire format from VeriScan is `YYYY-MM-DD` already, so the
  // most common path is a no-op. We still defensively pin the first
  // 10 chars to absorb any future variant that smuggles a time
  // component in.
  return trimmed.slice(0, 10)
}

function normaliseState(state: string | null): string {
  if (state === null) return ''
  return state.trim().toUpperCase()
}

function normaliseZip5(postal: string | null): string {
  if (postal === null) return ''
  const digits = postal.replace(/[^0-9]/g, '')
  return digits.slice(0, 5)
}

export interface PersonKeyInputs {
  firstName: string | null
  lastName: string | null
  birthDate: string | null
  state: string | null
  postalCode: string | null
}

/**
 * Returns a stable join key, or null when the inputs are too thin
 * (no name) to be meaningful. Never throws.
 */
export function computePersonKey(inputs: PersonKeyInputs): string | null {
  const name = normaliseName(inputs.firstName, inputs.lastName)
  if (name === null) return null
  const birth = normaliseBirthDate(inputs.birthDate)
  const state = normaliseState(inputs.state)
  const zip = normaliseZip5(inputs.postalCode)
  return `${name}|${birth}|${state}|${zip}`
}
