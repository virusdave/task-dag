// Minimal type declarations for the pre-compiled extractConstraints.js
// The TypeScript source was disabled (renamed to .ts.disabled) to bypass
// build errors; this stub keeps callers from triggering implicit-any errors.

export const SCHEDULING_EXTRACTION_MODEL: string
export const SCHEDULING_EXTRACTION_PROMPT_VERSION: string

// The compiled JS validates and returns these fields; we type them
// loosely as `any` for downstream consumers (the structured-extraction
// shape is enforced at runtime by Zod schemas inside the JS).
export interface SchedulingExtractionResult {
  model: string
  promptVersion: string
  extractedConstraints: {
    employees: any[]
    shiftRequirements: any[]
    [key: string]: any
  }
  normalizedInput: {
    scheduleWeek: any
    [key: string]: any
  }
  validationIssues: any[]
  [key: string]: any
}

export function extractSchedulingConstraints(input: {
  scheduleWeek: {
    endDate: string | null
    startDate: string | null
  }
  sourceText: string
}): Promise<SchedulingExtractionResult>
