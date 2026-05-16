import type { RuntimeDependencyStatus } from '../../shared/contracts/api/session.js'
import { getWorkerEnv } from '../../worker/config/env.js'
import { getGoogleOAuthConfigurationIssue, getServerEnv, isGoogleOAuthReady } from '../config/env.js'

export function buildRuntimeDependencyStatuses(): RuntimeDependencyStatus[] {
  const serverEnv = getServerEnv()
  const workerEnv = getWorkerEnv()
  const googleOAuthIssue = getGoogleOAuthConfigurationIssue(serverEnv)

  return [
    {
      code: 'google_oauth',
      label: 'Google OAuth',
      status: isGoogleOAuthReady(serverEnv) ? 'configured' : 'missing',
      summary: isGoogleOAuthReady(serverEnv)
        ? serverEnv.googleAllowedEmails.length > 0
          ? `Sign-in is configured for ${serverEnv.googleAllowedDomain} plus: ${serverEnv.googleAllowedEmails.join(', ')}.`
          : `Sign-in is configured for ${serverEnv.googleAllowedDomain}.`
        : googleOAuthIssue ?? 'Sign-in is unavailable until the Google OAuth client ID, secret, and redirect URI are configured.',
    },
    {
      code: 'sweed',
      label: 'Sweed',
      status: workerEnv.sweedAuthToken ? 'configured' : 'missing',
      summary: workerEnv.sweedAuthToken
        ? `Worker automation is configured for state dealer ${workerEnv.sweedStateDealerId}.`
        : 'Worker sync and reconcile jobs stay queued until SWEED_AUTH_TOKEN is configured.',
    },
    {
      code: 'bedrock',
      label: 'Bedrock',
      status: workerEnv.bedrockMantleBearerToken ? 'configured' : 'missing',
      summary: workerEnv.bedrockMantleBearerToken
        ? 'Description generation and debug reruns are configured.'
        : 'Description generation and description/debug reruns stay queued until the Bedrock Mantle bearer token is configured.',
    },
    {
      code: 'litalerts',
      label: 'Lit Alerts',
      status: workerEnv.litAlertsBearerToken ? 'configured' : 'optional_missing',
      summary: workerEnv.litAlertsBearerToken
        ? 'Pricing generation can enrich proposals with market evidence.'
        : 'Pricing generation still works, but Lit Alerts market evidence is disabled until LITALERTS_BEARER_TOKEN is configured.',
    },
  ]
}
