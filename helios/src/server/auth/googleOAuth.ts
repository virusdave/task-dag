import { OAuth2Client } from 'google-auth-library'

import { getServerEnv, hasGoogleOAuthConfig } from '../config/env.js'

export interface GoogleProfile {
  email: string
  googleSub: string
  name: string
}

interface GoogleOAuthConfig {
  googleAllowedDomain: string
  googleAllowedEmails: string[]
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
}

export function buildGoogleAuthorizationUrl(state: string): string {
  const config = requireGoogleOAuthConfig()
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri)

  // NOTE: Deliberately do not set `hd:` here. The Google `hd` hint locks the
  // account chooser to a single hosted domain, which would exclude the
  // explicitly allowlisted non-domain emails (e.g. dave.nicponski@gmail.com).
  // Domain + email enforcement is applied server-side in
  // `exchangeGoogleAuthorizationCode` after the ID token comes back.
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  })
}

export async function exchangeGoogleAuthorizationCode(code: string): Promise<GoogleProfile> {
  const config = requireGoogleOAuthConfig()
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri)
  const tokenResponse = await client.getToken(code)

  if (!tokenResponse.tokens.id_token) {
    throw new Error('Google callback did not return an ID token.')
  }

  const ticket = await client.verifyIdToken({
    audience: config.googleClientId,
    idToken: tokenResponse.tokens.id_token,
  })
  const payload = ticket.getPayload()

  if (!payload?.sub || !payload.email || !payload.name) {
    throw new Error('Google callback payload is missing required profile fields.')
  }

  if (!payload.email_verified) {
    throw new Error('Google account email is not verified.')
  }

  const normalizedEmail = payload.email.toLowerCase()
  const emailDomain = normalizedEmail.split('@')[1] ?? ''
  const domainAllowed = emailDomain === config.googleAllowedDomain.toLowerCase()
  const emailAllowed = config.googleAllowedEmails.includes(normalizedEmail)
  if (!domainAllowed && !emailAllowed) {
    throw new Error(`This Google account is not permitted to sign in to Helios.`)
  }

  return {
    email: payload.email,
    googleSub: payload.sub,
    name: payload.name,
  }
}

function requireGoogleOAuthConfig(): GoogleOAuthConfig {
  const env = getServerEnv()
  if (!hasGoogleOAuthConfig(env)) {
    throw new Error(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
    )
  }

  return {
    googleAllowedDomain: env.googleAllowedDomain,
    googleAllowedEmails: env.googleAllowedEmails,
    googleClientId: env.googleClientId!,
    googleClientSecret: env.googleClientSecret!,
    googleRedirectUri: env.googleRedirectUri!,
  }
}
