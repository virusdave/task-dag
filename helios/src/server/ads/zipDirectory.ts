/**
 * In-process ZIP helpers backed by `fflate` (pure-JS deflate).
 *
 * We deliberately do not shell out to the system `zip` binary —
 * historically that has bitten us in two ways:
 *
 *   1. helios runs in a hardened systemd unit where PATH is minimal
 *      and `zip` is not part of the closure. The morning bundle
 *      pipeline was failing with `spawn zip ENOENT` because of this.
 *   2. Even when present, `zip` is an undeclared system dependency:
 *      it isn't tracked in package.json, nix-shell, or anywhere else
 *      a deployer can see, so it silently breaks when the runtime
 *      environment changes.
 *
 * `fflate` is small (~30KB), pure JS, has no native deps, and ships
 * a synchronous API that's perfectly fine for the bundle sizes we
 * deal with (a few CSVs + an HTML packet + small JSON files, well
 * under a megabyte total).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { zipSync, type Zippable } from 'fflate'

/**
 * Recursively read a directory and return a ZIP buffer whose entries
 * are rooted at the directory's children (no extra top-level prefix —
 * unzipping into a fresh working directory writes the children
 * directly, matching `zip -r - .` behavior).
 */
export async function zipDirectoryToBuffer(dir: string): Promise<Buffer> {
  const tree: Zippable = {}
  await collectInto(tree, dir, '')
  const bytes = zipSync(tree, { level: 6 })
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

async function collectInto(
  tree: Zippable,
  absDir: string,
  relPrefix: string,
): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name)
    // ZIP uses forward slashes regardless of host OS.
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      await collectInto(tree, abs, rel)
    } else if (entry.isFile()) {
      const data = await fs.readFile(abs)
      tree[rel] = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      )
    }
    // symlinks, sockets, etc. are skipped — none of the run dirs
    // contain anything but regular files + directories.
  }
}
