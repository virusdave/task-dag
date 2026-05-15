import { OAuth2Client } from 'google-auth-library'

import { getServerEnv, hasGoogleOAuthConfig } from '../config/env.js'

export interface GoogleProfile {
  email: string
  googleSub: string
  name: string
}

interface GoogleOAuthConfig {
  googleAllowedDomain: string
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
}

export function buildGoogleAuthorizationUrl(state: string): string {
  const config = requireGoogleOAuthConfig()
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri)

  return client.generateAuthUrl({
    access_type: 'offline',
    hd: config.googleAllowedDomain,
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

  const emailDomain = payload.email.split('@')[1]?.toLowerCase() ?? ''
  if (emailDomain !== config.googleAllowedDomain.toLowerCase()) {
    throw new Error(`Only ${config.googleAllowedDomain} accounts can sign in.`)
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
    googleClientId: env.googleClientId!,
    googleClientSecret: env.googleClientSecret!,
    googleRedirectUri: env.googleRedirectUri!,
  }
}
