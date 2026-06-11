// Parse and evaluate a manifest `min_renderer_version` constraint such
// as `mss-lp-runtime>=0.4.0` against the running renderer's version.
//
// Deliberately tiny: we only need the operators we emit (`>=`, `>`,
// `=`/`==`). Anything we can't parse is treated as UNSATISFIED so the
// loader/validator fails closed (parent EPIC_PLAN §5 step 3, §11).

const CONSTRAINT_RE = /^([A-Za-z0-9_.-]+?)\s*(>=|>|==|=)\s*([0-9]+(?:\.[0-9]+){0,2})$/

export interface RendererConstraint {
  readonly component: string
  readonly operator: '>=' | '>' | '='
  readonly version: string
}

export function parseRendererConstraint(raw: string): RendererConstraint | null {
  const m = CONSTRAINT_RE.exec(raw.trim())
  if (!m) return null
  const op = m[2] === '==' ? '=' : (m[2] as '>=' | '>' | '=')
  return { component: m[1], operator: op, version: m[3] }
}

function parts(v: string): [number, number, number] {
  const seg = v.split('.').map((x) => Number.parseInt(x, 10))
  return [seg[0] ?? 0, seg[1] ?? 0, seg[2] ?? 0]
}

/** -1 if a<b, 0 if equal, 1 if a>b (semver-ish, 3 numeric segments). */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

/**
 * Is `runningVersion` (a bare semver string) sufficient for the given
 * `min_renderer_version` constraint? Unparseable constraints → false
 * (fail closed).
 */
export function satisfiesRendererConstraint(constraintRaw: string, runningVersion: string): boolean {
  const c = parseRendererConstraint(constraintRaw)
  if (!c) return false
  const cmp = compareVersions(runningVersion, c.version)
  switch (c.operator) {
    case '>=':
      return cmp >= 0
    case '>':
      return cmp > 0
    case '=':
      return cmp === 0
  }
}
