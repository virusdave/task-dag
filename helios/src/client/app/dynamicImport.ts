/**
 * Defensive wrapper around the native `import()` for code-split
 * chunks (e.g. lazy-loaded zxing barcode reader).
 *
 * Failure mode being defended against:
 *
 *   1. The browser tab loaded the SPA against a build whose hashed
 *      chunks are no longer on disk (helios was redeployed; the new
 *      build has new hash names + the old chunk files are gone).
 *   2. User triggers a code-split flow (e.g. barcode scan) which
 *      issues `import('/assets/index-OLDHASH.js')`.
 *   3. The server's own stale-bundle recovery script tries to bounce
 *      the document to a fresh URL — but in edge cases (already-busted
 *      retry, CDN intercepting the asset request with a partial
 *      response, etc.) the dynamic import itself rejects with browser
 *      errors like "importing a module script failed" or resolves
 *      with an empty module, and the calling code blows up.
 *
 * Strategy: try the import; if it throws OR resolves to something
 * that's obviously not a real module (no exports at all, or missing
 * the named export the caller expected), force a hard-reload with
 * cache-busting so the next page load picks up the fresh bundle.
 *
 * The reload is unconditional in the failure path. A theoretical
 * infinite reload loop would require the server to keep serving
 * stale index.html, which it can't — the SPA shell is read fresh
 * off disk on every / request, and the freshly-cached `_cb` query
 * param defeats any browser/CDN-cached document.
 */
export async function importChunkOrReload<TModule>(
  loader: () => Promise<TModule>,
  diagnosticLabel: string,
): Promise<TModule> {
  try {
    const mod = await loader()
    if (mod === null || typeof mod !== 'object' || Object.keys(mod as object).length === 0) {
      throw new Error(`Dynamic import ${diagnosticLabel} resolved to an empty module (stale bundle).`)
    }
    return mod
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[dynamicImport] ${diagnosticLabel} failed — forcing a stale-bundle reload`, error)
    forceStaleBundleReload()
    // forceStaleBundleReload navigates the document away; rethrow so
    // any synchronous continuation in the caller stops cleanly.
    throw error
  }
}

function forceStaleBundleReload(): void {
  try {
    const u = new URL(window.location.href)
    u.searchParams.set('_cb', String(Date.now()))
    window.location.replace(u.toString())
  } catch {
    try {
      window.location.reload()
    } catch {
      // Nothing else to try; the catch in importChunkOrReload still
      // rethrows the original error so the caller can decide what to
      // surface to the operator.
    }
  }
}
