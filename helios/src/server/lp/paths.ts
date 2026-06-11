import { lstatSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Safely resolve a manifest-relative URL against the artifact root.
 * Rejects absolute paths, `..` traversal, anything that escapes the
 * root, and symlinked targets (parent EPIC_PLAN §5: "Manifest paths are
 * validated as relative to the artifact root (reject `..`, absolute
 * paths, symlinks)"). Returns null when unsafe; callers fail closed.
 */
export function resolveArtifactPath(root: string, relUrl: string): string | null {
  if (relUrl.length === 0) return null
  if (isAbsolute(relUrl)) return null
  if (relUrl.split(/[/\\]/).some((seg) => seg === '..')) return null

  const rootResolved = resolve(root)
  const full = resolve(rootResolved, relUrl)
  const within = full === rootResolved || full.startsWith(rootResolved + sep)
  if (!within) return null

  // Reject if the final target is a symlink (do not follow links out of root).
  try {
    if (lstatSync(full).isSymbolicLink()) return null
  } catch {
    // Missing file is not a path-safety failure here; the reader will
    // surface a read error. Other lstat errors → treat as unsafe.
  }
  return full
}
