/**
 * Minimal ambient type declaration for `js-yaml` (a runtime dependency of
 * helios that ships without bundled types and has no `@types/js-yaml` in this
 * repo's install).
 *
 * We deliberately declare only the tiny surface the advisory-catalog code
 * uses (`load` / `dump`) with precise, non-`any` types rather than pulling in
 * `@types/js-yaml`: the ephemeral-checkout `node_modules` is a symlink to a
 * shared tree, so adding a dev-dependency there is not self-contained. This
 * is the exact workaround TS's own TS7016 diagnostic suggests.
 */
declare module 'js-yaml' {
  /** Parse the first YAML document in `input` into a JS value. */
  export function load(input: string): unknown

  export interface DumpOptions {
    /** Indentation level at which to switch to flow (inline) style. */
    flowLevel?: number
    /** Max line width; -1 disables wrapping. */
    lineWidth?: number
    /** Preferred scalar quoting style. */
    quotingType?: "'" | '"'
    /** Force quoting of all scalars. */
    forceQuotes?: boolean
    /** Sort object keys (default: preserve insertion order). */
    sortKeys?: boolean
  }

  /** Serialize `obj` to a YAML string. */
  export function dump(obj: unknown, options?: DumpOptions): string

  const jsYaml: {
    load: typeof load
    dump: typeof dump
  }
  export default jsYaml
}
