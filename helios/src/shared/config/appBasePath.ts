export function deriveBasePathFromAppBaseUrl(appBaseUrl: string): string {
  return normalizeBasePath(new URL(appBaseUrl).pathname)
}

export function joinBasePath(basePath: string, path: string): string {
  const normalizedBasePath = normalizeBasePath(basePath)
  const normalizedPath = normalizePath(path)
  return normalizedBasePath === '/' ? normalizedPath : `${normalizedBasePath}${normalizedPath}`
}

export function normalizeBasePath(pathname: string): string {
  const normalizedPath = normalizePath(pathname)
  return normalizedPath === '/' ? normalizedPath : normalizedPath.replace(/\/+$/, '')
}

export function toViteBasePath(basePath: string): string {
  const normalizedBasePath = normalizeBasePath(basePath)
  return normalizedBasePath === '/' ? normalizedBasePath : `${normalizedBasePath}/`
}

function normalizePath(path: string): string {
  const trimmedPath = path.trim()
  if (!trimmedPath || trimmedPath === '/') {
    return '/'
  }

  const withLeadingSlash = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`
  const collapsedSlashes = withLeadingSlash.replace(/\/{2,}/g, '/')
  return collapsedSlashes || '/'
}
