import * as path from 'node:path'

import { getTaskDagLocalPath } from '../taskDagMirror.js'

/** Resolve only an explicitly registered working checkout; never guess. */
export function getConfiguredRepositoryRoot(repository: string): string {
  return getTaskDagLocalPath(repository)
}

export function configuredRepositoryPath(repository: string, ...segments: string[]): string {
  return path.join(getConfiguredRepositoryRoot(repository), ...segments)
}
