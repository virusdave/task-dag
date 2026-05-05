import { normalizeBasePath, joinBasePath } from '../../shared/config/appBasePath.js'

const appBasePath = normalizeBasePath(import.meta.env.BASE_URL)

export function buildAppPath(path: string): string {
  return joinBasePath(appBasePath, path)
}

export function getAppBasePath(): string {
  return appBasePath
}
