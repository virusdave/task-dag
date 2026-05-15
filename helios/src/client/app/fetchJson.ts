import { redirect } from 'react-router-dom'
import type { z } from 'zod'

import { buildAppPath } from './paths.js'

export async function loadJson<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.infer<TSchema>> {
  const response = await fetch(buildAppPath(path), {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...init,
  })

  if (response.status === 401) {
    throw redirect('/login')
  }

  if (!response.ok) {
    const errorPayload = await maybeReadErrorPayload(response)
    throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
  }

  if (response.status === 204) {
    return schema.parse(null)
  }

  const payload = await response.json()
  return schema.parse(payload)
}

export async function mutateJson<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: RequestInit,
): Promise<z.infer<TSchema>> {
  return loadJson(path, schema, init)
}

async function maybeReadErrorPayload(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: string }
    return typeof payload.error === 'string' ? payload.error : null
  } catch {
    return null
  }
}
