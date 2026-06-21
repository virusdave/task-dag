// Config -> Integrations -> Bedrock models
//
// Below-the-fold operator page for setting a rare per-context LLM model
// override (operator decision 1, child #54 task C4). Each LLM use-point
// defaults to the current "standard, most capable" model chosen at call time;
// this page lets an admin pin a different model id for one context without a
// code change. v1 exposes only the prospective pending-purchase classifier.
//
// Satisfies: virusdave/top-level#33

import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  BedrockModelConfigGetResponseSchema,
  type BedrockModelConfigGetResponse,
  type BedrockModelContextState,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function configBedrockModelsLoader(): Promise<BedrockModelConfigGetResponse> {
  return loadJson('/api/config/bedrock-models', BedrockModelConfigGetResponseSchema)
}

function seedDrafts(contexts: readonly BedrockModelContextState[]): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const context of contexts) {
    drafts[context.key] = context.overrideModel ?? ''
  }
  return drafts
}

export function ConfigBedrockModelsPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as BedrockModelConfigGetResponse
  const revalidator = useRevalidator()

  const [drafts, setDrafts] = useState<Record<string, string>>(() => seedDrafts(data.contexts))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const dirty = data.contexts.some(
    (context) => (drafts[context.key] ?? '').trim() !== (context.overrideModel ?? ''),
  )
  const hasAnyOverride = data.contexts.some((context) => context.overrideModel !== null)

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const overrides: Record<string, string> = {}
      for (const context of data.contexts) {
        const value = (drafts[context.key] ?? '').trim()
        if (value) overrides[context.key] = value
      }
      await mutateJson('/api/config/bedrock-models', BedrockModelConfigGetResponseSchema, {
        method: 'PUT',
        body: JSON.stringify({ overrides }),
      })
      setNotice('Saved.')
      revalidator.revalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save.')
    } finally {
      setBusy(false)
    }
  }

  async function resetAll() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await mutateJson(
        '/api/config/bedrock-models',
        BedrockModelConfigGetResponseSchema,
        { method: 'DELETE' },
      )
      setDrafts(seedDrafts(response.contexts))
      setNotice('All overrides cleared; using code defaults.')
      revalidator.revalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to clear overrides.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: '1rem', maxWidth: 920 }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Bedrock models</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Per-context LLM model override. Leave blank to use the default. Rarely needed.
      </p>

      <datalist id="bedrock-model-suggestions">
        {data.suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
        {data.contexts.map((context) => {
          const draft = drafts[context.key] ?? ''
          const trimmedDraft = draft.trim()
          const dirtyRow = trimmedDraft !== (context.overrideModel ?? '')
          const afterSave = trimmedDraft || context.defaultModel
          return (
            <div
              key={context.key}
              style={{
                border: '1px solid #ddd',
                borderRadius: 8,
                padding: '0.75rem 1rem',
              }}
            >
              <div style={{ fontWeight: 600 }}>{context.label}</div>
              <div style={{ color: '#666', fontSize: '0.85rem', margin: '0.25rem 0 0.5rem' }}>
                {context.description}
              </div>
              <label style={{ display: 'block', fontSize: '0.85rem', color: '#444' }}>
                Override model id
                <input
                  type="text"
                  list="bedrock-model-suggestions"
                  placeholder={context.defaultModel}
                  value={draft}
                  disabled={busy}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [context.key]: event.target.value }))
                  }
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: 480,
                    marginTop: '0.25rem',
                    padding: '0.4rem 0.5rem',
                    fontFamily: 'monospace',
                  }}
                />
              </label>
              <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.4rem' }}>
                Default: <code>{context.defaultModel}</code> · Current:{' '}
                <code>{context.effectiveModel}</code>
                {context.overrideModel ? ' (override)' : ''}
                {dirtyRow ? (
                  <>
                    {' · After save: '}
                    <code>{afterSave}</code>
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
          marginTop: '1rem',
        }}
      >
        <button type="button" onClick={save} disabled={busy || !dirty}>
          Save
        </button>
        <button type="button" onClick={resetAll} disabled={busy || !hasAnyOverride}>
          Clear all overrides
        </button>
        {notice ? <span style={{ color: '#2a7' }}>{notice}</span> : null}
        {error ? <span style={{ color: '#c33' }}>{error}</span> : null}
      </div>

      {data.updatedBy ? (
        <p style={{ color: '#999', fontSize: '0.8rem', marginTop: '0.75rem' }}>
          Last changed by {data.updatedBy}
          {data.updatedAt ? ` at ${nyLongDateTime(Date.parse(data.updatedAt))} NY` : ''}.
        </p>
      ) : null}

      <details style={{ marginTop: '1.5rem', color: '#555' }}>
        <summary style={{ cursor: 'pointer' }}>About this page</summary>
        <p style={{ fontSize: '0.85rem' }}>
          Each LLM use-point in Helios defaults to the current standard, most capable general
          reasoning model, chosen at call time so all use-points move together when that default
          is bumped in code. An override here pins a specific model id for one context for testing
          or a rare exception. The model id is whatever the Bedrock gateway accepts; the
          suggestions list is only a convenience. If you set an override to a model the gateway
          rejects, that context&apos;s LLM call will fail loudly rather than silently falling back.
        </p>
      </details>
    </div>
  )
}
