import type { JsonValue } from '../../../shared/contracts/common/json.js'

export function toIsoString(value: Date | null | string): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function jsonValueToPreview(value: JsonValue): string {
  if (typeof value === 'string') {
    return value
  }
  return JSON.stringify(value, null, 2)
}

export function buildTextPreview(value: JsonValue, limit = 160): { isTruncated: boolean; text: string } {
  const text = jsonValueToPreview(value)
  const normalized = text.replace(/\s+/g, ' ').trim()

  if (normalized.length <= limit) {
    return { isTruncated: false, text: normalized }
  }

  return {
    isTruncated: true,
    text: `${normalized.slice(0, limit - 1).trimEnd()}…`,
  }
}
