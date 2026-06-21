// Browser-navigation OAuth endpoints for external-platform integrations.
//
//   GET /integrations/:provider/start?handoff=<code>  → 302 to the provider
//   GET /integrations/:provider/callback              → 302 back into the app
//
// Both are top-level browser navigations from the mobile in-app browser, so
// there is no CORS to apply. The caller is identified by a short-lived,
// single-use handoff code minted over an authenticated GraphQL call
// (createIntegrationOAuthHandoff) — the session JWT itself never enters a URL,
// where it would persist in access logs, proxies, and browser history. The
// callback always lands the user back in the app via a deep link; failures
// carry a constrained `reason` enum so nothing attacker-controllable is
// reflected verbatim.

import type { IncomingMessage, ServerResponse } from 'http';
import { getProvider, isSupportedProvider, type ProviderName } from '../integrations/registry';
import { signIntegrationState, verifyIntegrationHandoff, verifyIntegrationState } from '../integrations/state';
import { upsertCredential } from '../integrations/credentials';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';

/**
 * Constrained callback failure reasons. The mobile app maps these to copy; an
 * unrecognised provider `error=` param collapses to 'oauth_error' so nothing
 * attacker-controllable reaches the deep link verbatim. Mirrors
 * safeOauthErrorReason in the web kilter callback.
 */
const REFLECTABLE_OAUTH_ERRORS = new Set<string>([
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);

type CallbackReason =
  | 'oauth_error'
  | 'state_invalid'
  | 'missing_params'
  | 'missing_scope'
  | 'exchange_failed'
  | 'persist_failed'
  | 'server_error';

function safeOauthErrorReason(raw: string): string {
  return REFLECTABLE_OAUTH_ERRORS.has(raw) ? raw : 'oauth_error';
}

function sendText(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(message);
}

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function deepLinkBase(provider: ProviderName): string {
  return `com.boardsesh.app://integrations/${provider}`;
}

function redirectSuccess(res: ServerResponse, provider: ProviderName): void {
  redirectTo(res, `${deepLinkBase(provider)}?status=connected`);
}

function redirectError(res: ServerResponse, provider: ProviderName, reason: string): void {
  redirectTo(res, `${deepLinkBase(provider)}?status=error&reason=${encodeURIComponent(reason)}`);
}

/** Public backend origin used to build provider redirect URIs (no trailing slash). */
function getBackendPublicUrl(): string | null {
  const raw = process.env.BACKEND_PUBLIC_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Single-use enforcement for handoff codes. Redis remembers each consumed
 * nonce for the handoff lifetime; a second consumption is rejected.
 *
 * Failure posture is split: when Redis is simply not configured (local dev),
 * the HMAC + 60-second expiry still bound the exposure and the flow degrades
 * to expiry-only. But when a supposedly-healthy Redis errors mid-check, we
 * fail CLOSED — replay protection must not silently turn into a no-op during
 * an outage, and the only user cost is retrying the connect button.
 */
async function consumeHandoffNonce(nonce: string): Promise<boolean> {
  if (!redisClientManager.isRedisConnected()) {
    return true;
  }
  try {
    const { publisher } = redisClientManager.getClients();
    const setResult = await publisher.set(`integrations:handoff:${nonce}`, '1', 'EX', 120, 'NX');
    return setResult === 'OK';
  } catch (error) {
    logger.warn('[Integrations] Redis handoff-nonce check failed, rejecting handoff:', error);
    return false;
  }
}

/**
 * GET /integrations/:provider/start?handoff=<code>
 * Verifies the single-use handoff code (which carries the userId), signs an
 * OAuth state, and redirects to the provider's authorize URL.
 */
export async function handleIntegrationOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  providerName: string,
  url: URL,
): Promise<void> {
  if (!isSupportedProvider(providerName)) {
    sendText(res, 404, 'Unknown integration provider');
    return;
  }
  const provider = getProvider(providerName);
  if (!provider) {
    sendText(res, 404, 'Unknown integration provider');
    return;
  }

  // Never log the handoff or the full URL.
  const handoff = url.searchParams.get('handoff');
  if (!handoff) {
    sendText(res, 401, 'Authentication required');
    return;
  }
  const verifiedHandoff = verifyIntegrationHandoff(handoff);
  if (!verifiedHandoff || verifiedHandoff.provider !== providerName) {
    sendText(res, 401, 'Invalid or expired handoff code');
    return;
  }
  if (!(await consumeHandoffNonce(verifiedHandoff.nonce))) {
    sendText(res, 401, 'Handoff code already used');
    return;
  }

  const backendPublicUrl = getBackendPublicUrl();
  if (!backendPublicUrl) {
    logger.error('[Integrations] BACKEND_PUBLIC_URL is not configured; cannot build redirect URI');
    sendText(res, 500, 'Integration is not configured');
    return;
  }

  let authorizeUrl: string;
  try {
    const redirectUri = `${backendPublicUrl}/integrations/${providerName}/callback`;
    const state = signIntegrationState({ userId: verifiedHandoff.userId, provider: providerName });
    authorizeUrl = provider.buildAuthorizeUrl(state, redirectUri);
  } catch (error) {
    logger.error('[Integrations] Failed to build authorize URL:', error);
    sendText(res, 500, 'Integration is not configured');
    return;
  }

  redirectTo(res, authorizeUrl);
}

/**
 * GET /integrations/:provider/callback
 * Provider redirect target. Verifies state, exchanges the code, persists
 * encrypted tokens, and redirects back into the app via deep link.
 */
export async function handleIntegrationOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  providerName: string,
  url: URL,
): Promise<void> {
  if (!isSupportedProvider(providerName)) {
    sendText(res, 404, 'Unknown integration provider');
    return;
  }
  const provider = getProvider(providerName);
  if (!provider) {
    sendText(res, 404, 'Unknown integration provider');
    return;
  }
  // Provider name is validated; the deep link uses the narrowed type.
  const providerDbName: ProviderName = providerName;

  // Provider-reported error (e.g. the user declined authorization).
  const providerError = url.searchParams.get('error');
  if (providerError) {
    redirectError(res, providerDbName, safeOauthErrorReason(providerError));
    return;
  }

  const state = url.searchParams.get('state');
  const verifiedState = state ? verifyIntegrationState(state) : null;
  if (!verifiedState || verifiedState.provider !== providerDbName) {
    redirectError(res, providerDbName, 'state_invalid' satisfies CallbackReason);
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    redirectError(res, providerDbName, 'missing_params' satisfies CallbackReason);
    return;
  }

  // Strava returns the granted scope on the callback. Require activity:write —
  // a read-only grant cannot upload activities, so fail early with clear copy
  // rather than at the first upload. Trim each entry: a "read, activity:write"
  // form (space after comma) must not read as a missing grant.
  const grantedScopes = (url.searchParams.get('scope') ?? '').split(',').map((scopeEntry) => scopeEntry.trim());
  if (!grantedScopes.includes('activity:write')) {
    redirectError(res, providerDbName, 'missing_scope' satisfies CallbackReason);
    return;
  }

  // Mirror the start handler's config check: without the public URL the
  // redirect URI sent to the token exchange would be a relative path, which
  // the provider rejects with an opaque upstream error instead of this clear
  // one. (Reaching here without it requires the env var vanishing mid-flow.)
  const backendPublicUrl = getBackendPublicUrl();
  if (!backendPublicUrl) {
    logger.error('[Integrations] BACKEND_PUBLIC_URL is not configured; cannot complete code exchange');
    redirectError(res, providerDbName, 'server_error' satisfies CallbackReason);
    return;
  }
  const redirectUri = `${backendPublicUrl}/integrations/${providerName}/callback`;

  let tokens;
  try {
    tokens = await provider.exchangeCode(code, redirectUri);
  } catch (error) {
    logger.error('[Integrations] Code exchange failed:', error);
    redirectError(res, providerDbName, 'exchange_failed' satisfies CallbackReason);
    return;
  }

  try {
    await upsertCredential(verifiedState.userId, providerDbName, tokens);
  } catch (error) {
    logger.error('[Integrations] Credential persistence failed:', error);
    redirectError(res, providerDbName, 'persist_failed' satisfies CallbackReason);
    return;
  }

  redirectSuccess(res, providerDbName);
}
