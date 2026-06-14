import { normalizeBasePath, joinBasePath } from '../../shared/config/appBasePath.js'
import { normalizeReturnToOrRoot } from '../../shared/config/returnTo.js'

const appBasePath = normalizeBasePath(import.meta.env.BASE_URL)

export function buildAppPath(path: string): string {
  return joinBasePath(appBasePath, path)
}

export function getAppBasePath(): string {
  return appBasePath
}

/**
 * The current location as a safe, app-base-relative `returnTo` value
 * (e.g. `/catalog/review?tab=x`), with the deployment base path
 * stripped. Used to remember where the user was when a session
 * expires mid-use so we can send them back after re-authenticating.
 */
export function getCurrentInAppReturnTo(): string {
  if (typeof window === 'undefined') {
    return '/'
  }
  let path = window.location.pathname
  if (appBasePath !== '/' && (path === appBasePath || path.startsWith(`${appBasePath}/`))) {
    path = path.slice(appBasePath.length) || '/'
  }
  return normalizeReturnToOrRoot(`${path}${window.location.search}${window.location.hash}`)
}
