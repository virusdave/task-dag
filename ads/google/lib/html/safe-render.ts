/**
 * safe-render — defensive HTML rendering for the morning ads packet.
 *
 * The L2 LLM (and the mock fallback when LLM creds are broken) can
 * easily hand us values that don't match the declared TypeScript
 * types: `undefined`, deeply-nested objects, arrays of objects,
 * Records whose `.toString()` is "[object Object]", etc. The
 * morning operator does NOT want to see "[object Object]" or bare
 * "undefined" in their packet — they want a sensible rendering of
 * whatever shape arrived. These helpers guarantee that.
 *
 * Three entry points, three call sites:
 *
 *   safeRender(value)  -> HTML for an *element body* (may emit tags)
 *   safeText(value)    -> escaped plain text for <title>, attrs,
 *                         and text nodes that must stay plain
 *   safeToken(value)   -> sanitized [a-z0-9-]+ token for id="",
 *                         class="" and #fragment refs
 *
 * Rules every helper obeys:
 *   - never emits '[object Object]' or the literal string 'undefined'
 *   - HTML-escapes every primitive
 *   - caps recursion depth and detects cycles
 */

export type SafeRenderMode = 'auto' | 'inline' | 'block'

export interface SafeRenderOptions {
  /**
   * Hint for how to render arrays/objects:
   *   'inline' = always comma-separated
   *   'block'  = always nested <ul>/<dl>
   *   'auto'   = inline for short flat lists, block for long/nested
   */
  mode?: SafeRenderMode
  /** Array length above which 'auto' chooses block layout. */
  longListThreshold?: number
  /** Max recursion depth before we collapse to '…'. */
  maxDepth?: number
  /** Label shown for null/undefined/NaN/empty values. Default '—'. */
  nullLabel?: string
}

const DEFAULTS = {
  mode: 'auto' as const,
  longListThreshold: 4,
  maxDepth: 4,
  nullLabel: '—',
}

/**
 * Escape HTML-significant chars. Always use this before injecting
 * any untrusted string into markup.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Plain-text safe rendering. Use for <title>, attribute values,
 * and any text node where we must NOT emit child tags.
 */
export function safeText(value: unknown, fallback?: string): string {
  const v = primitiveText(value)
  if (v === null) {
    return escapeHtml(fallback ?? DEFAULTS.nullLabel)
  }
  return escapeHtml(v)
}

/**
 * Sanitize a value into a [a-z0-9-]+ token for id="", class="",
 * and #fragment refs.
 */
export function safeToken(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined) return sanitizeToken(fallback)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return sanitizeToken(String(value)) || sanitizeToken(fallback)
  }
  return sanitizeToken(fallback)
}

/**
 * Render an unknown value as element-body HTML. May emit nested
 * <ul>/<dl> when the value is structured. Never emits
 * '[object Object]' or bare 'undefined'.
 */
export function safeRender(value: unknown, options?: SafeRenderOptions): string {
  const opts = { ...DEFAULTS, ...(options ?? {}) }
  return render(value, opts, 0, new WeakSet<object>())
}

// ----------------------------------------------------------------------
// internals
// ----------------------------------------------------------------------

function render(
  value: unknown,
  opts: Required<SafeRenderOptions>,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (depth > opts.maxDepth) {
    return `<span class="sr-truncated" title="depth limit">…</span>`
  }

  // Handle primitive / null / undefined first. primitiveText
  // ALSO returns null for objects+arrays (signalling "caller
  // handles them"), so we must distinguish those before treating
  // a null primitiveText as "empty".
  if (typeof value !== 'object' || value === null) {
    const prim = primitiveText(value)
    if (prim === null) {
      return `<span class="sr-empty">${escapeHtml(opts.nullLabel)}</span>`
    }
    return escapeHtml(prim)
  }

  // From here on, value is a non-null object or array.
  if (seen.has(value as object)) {
    return `<span class="sr-truncated" title="circular">(circular)</span>`
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    return renderArray(value, opts, depth, seen)
  }
  // Plain object / Record / Map-like.
  return renderObject(value as Record<string, unknown>, opts, depth, seen)
}

function renderArray(
  arr: unknown[],
  opts: Required<SafeRenderOptions>,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (arr.length === 0) {
    return `<span class="sr-empty">${escapeHtml(opts.nullLabel)}</span>`
  }
  const allFlat = arr.every((item) => !isStructured(item))
  const useInline =
    opts.mode === 'inline' ||
    (opts.mode === 'auto' && allFlat && arr.length <= opts.longListThreshold)
  if (useInline) {
    return arr.map((item) => render(item, opts, depth + 1, seen)).join(', ')
  }
  const items = arr
    .map((item) => `<li>${render(item, opts, depth + 1, seen)}</li>`)
    .join('')
  return `<ul class="sr-list">${items}</ul>`
}

function renderObject(
  obj: Record<string, unknown>,
  opts: Required<SafeRenderOptions>,
  depth: number,
  seen: WeakSet<object>,
): string {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return `<span class="sr-empty">${escapeHtml(opts.nullLabel)}</span>`
  }
  const useInline =
    opts.mode === 'inline' && entries.every(([, v]) => !isStructured(v))
  if (useInline) {
    return entries
      .map(([k, v]) => `${escapeHtml(humanizeKey(k))}: ${render(v, opts, depth + 1, seen)}`)
      .join(', ')
  }
  const rows = entries
    .map(
      ([k, v]) =>
        `<div class="sr-row"><dt>${escapeHtml(humanizeKey(k))}</dt><dd>${render(
          v,
          opts,
          depth + 1,
          seen,
        )}</dd></div>`,
    )
    .join('')
  return `<dl class="sr-object">${rows}</dl>`
}

function isStructured(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (Array.isArray(v)) return true
  return typeof v === 'object'
}

/**
 * Coerce a value to a displayable primitive string, or return null
 * to indicate "render the empty/null label instead".
 */
function primitiveText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null
    return String(value)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (s === '') return null
    // Treat already-stringified garbage as null so upstream
    // `[object Object]` or `undefined`-as-string never reaches
    // the operator.
    if (/^(undefined|null|nan)$/i.test(s)) return null
    if (/^\[object\s+[^\]]+\]$/.test(s)) return null
    return value
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'bigint') return value.toString()
  return null // objects/arrays — caller handles them
}

function humanizeKey(k: string): string {
  if (!k) return k
  // snake_case -> Title Case for friendlier display.
  const spaced = k.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function sanitizeToken(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
  return out
}
