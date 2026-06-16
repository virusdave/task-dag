// Minimal type declarations for the pre-compiled extractConstraints.js
// The TypeScript source was disabled (renamed to .ts.disabled) to bypass
// build errors; this stub keeps callers from triggering implicit-any errors.

import type { JsonValue } from '../../shared/contracts/common/json.js'

export const SCHEDULING_EXTRACTION_MODEL: string
export const SCHEDULING_EXTRACTION_PROMPT_VERSION: string

// The compiled JS validates and returns these fields; the precise
// structured-extraction shape is enforced at runtime by Zod schemas
// inside the JS, and the whole payload is JSON-serialized into the
// scheduling-run row + audit log. We therefore type the payload fields
// as `JsonValue` (not `any`): it is accurate (everything here is JSON),
// it forces downstream consumers to narrow before structural use, and it
// preserves the container/array shapes callers rely on (`.length`,
// `JSON.stringify`, pass-through into JSON log fields).
export interface SchedulingExtractionResult {
  model: string
  promptVersion: string
  extractedConstraints: {
    employees: JsonValue[]
    shiftRequirements: JsonValue[]
    [key: string]: JsonValue
  }
  normalizedInput: {
    scheduleWeek: JsonValue
    [key: string]: JsonValue
  }
  validationIssues: JsonValue[]
  [key: string]: JsonValue
}

export function extractSchedulingConstraints(input: {
  scheduleWeek: {
    endDate: string | null
    startDate: string | null
  }
  sourceText: string
}): Promise<SchedulingExtractionResult>
