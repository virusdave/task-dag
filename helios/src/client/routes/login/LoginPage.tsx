import { useState, type FormEvent } from 'react'
import { redirect, useLoaderData } from 'react-router-dom'
import { z } from 'zod'

import type { SessionEnvelope } from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { loadSession } from '../../app/session.js'

const DevLoginResponseSchema = z.null()

export async function loginLoader() {
  const session = await loadSession()
  if (session.user) {
    throw redirect('/')
  }
  return session
}

export function LoginPage() {
  const session = useLoaderData() as SessionEnvelope
  const googleOAuthStatus = session.runtimeDependencies.find((dependency) => dependency.code === 'google_oauth')
  const [devLoginEmail, setDevLoginEmail] = useState('')
  const [devLoginError, setDevLoginError] = useState<string | null>(null)
  const [isSubmittingDevLogin, setIsSubmittingDevLogin] = useState(false)

  async function handleDevLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDevLoginError(null)
    setIsSubmittingDevLogin(true)

    try {
      await mutateJson('/api/auth/dev-login', DevLoginResponseSchema, {
        body: JSON.stringify({ email: devLoginEmail }),
        method: 'POST',
      })
      window.location.assign(buildAppPath('/'))
    } catch (error) {
      setDevLoginError(error instanceof Error ? error.message : 'Local dev sign-in failed.')
      setIsSubmittingDevLogin(false)
    }
  }

  return (
    <section className="hero-card">
      <p className="eyebrow">Helios</p>
      <h2>Review proposals, preserve audit history, and reconcile safely.</h2>
      <p>
        Sign in with your <code>@freshlybaked.nyc</code> Google account. Access is still gated by a pre-provisioned local
        user record, so new operators must be added before first login.
      </p>
      {googleOAuthStatus && googleOAuthStatus.status !== 'configured' ? <p className="error-text">{googleOAuthStatus.summary}</p> : null}
      {googleOAuthStatus?.status === 'configured' ? (
        <a className="primary-button" href={buildAppPath('/api/auth/google/start')}>
          Continue with Google
        </a>
      ) : null}
      {googleOAuthStatus?.status !== 'configured' ? (
        <form onSubmit={handleDevLoginSubmit} style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
          <label style={{ display: 'grid', gap: '0.35rem' }}>
            <span>Local dev sign-in email</span>
            <input
              autoComplete="email"
              disabled={isSubmittingDevLogin}
              onChange={(event) => setDevLoginEmail(event.target.value)}
              placeholder="you@freshlybaked.nyc"
              type="email"
              value={devLoginEmail}
            />
          </label>
          {devLoginError ? <p className="error-text">{devLoginError}</p> : null}
          <button className="secondary-button" disabled={isSubmittingDevLogin || devLoginEmail.trim().length === 0} type="submit">
            {isSubmittingDevLogin ? 'Signing in...' : 'Use Local Dev Sign-In'}
          </button>
        </form>
      ) : null}
    </section>
  )
}
