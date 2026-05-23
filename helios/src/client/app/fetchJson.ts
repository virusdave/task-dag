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
  // Try to surface as much useful diagnostic information as the
  // server gave us. Most helios routes return
  //   { error: "<one-line summary>", detail?: "<multi-line stderr/stack>" }
  // and the previous implementation dropped `detail` on the floor,
  // leaving the UI showing only "502" or a useless one-line summary.
  // We now include both fields when present, plus the HTTP status,
  // so the operator can actually see what went wrong without
  // tailing helios-server logs.
  let bodyText: string | null = null
  try {
    bodyText = await response.text()
  } catch {
    return `${response.status} ${response.statusText}`
  }
  if (!bodyText) {
    return `${response.status} ${response.statusText}`
  }
  // Try JSON shape first.
  try {
    const payload = JSON.parse(bodyText) as { error?: unknown; detail?: unknown; message?: unknown }
    const error =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : null
    const detail = typeof payload.detail === 'string' ? payload.detail : null
    if (error && detail) {
      return `${response.status}: ${error}\n\n${detail}`
    }
    if (error) {
      return `${response.status}: ${error}`
    }
    if (detail) {
      return `${response.status}: ${detail}`
    }
    // JSON parsed but didn't match the expected shape — fall back
    // to surfacing the raw body, so nothing is silently dropped.
    return `${response.status} ${response.statusText}: ${bodyText.slice(0, 4000)}`
  } catch {
    // Not JSON (e.g. nginx/upstream 502 HTML, or a plain text reply).
    // Surface the raw body — the operator needs *something* to
    // diagnose with.
    const trimmed = bodyText.trim().slice(0, 4000)
    return trimmed
      ? `${response.status} ${response.statusText}: ${trimmed}`
      : `${response.status} ${response.statusText}`
  }
}
