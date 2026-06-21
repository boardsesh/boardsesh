import * as WebBrowser from 'expo-web-browser';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  CREATE_INTEGRATION_OAUTH_HANDOFF,
  type CreateIntegrationOAuthHandoffResponse,
} from '@boardsesh/graphql/operations/integrations';
import { track } from '../analytics';
import { reportHandledError } from '../error-reporting';
import { parseDeepLinkQueryParams } from '../deep-link-query';
import { BACKEND_URL } from '../env';
import { getHttpClient } from '../graphql/client';

export type StravaConnectResult = 'connected' | 'error' | 'cancelled';

const STRAVA_REDIRECT_URL = 'com.boardsesh.app://integrations/strava';

/**
 * Connect the signed-in user's Strava account. Mints a short-lived single-use
 * handoff code over the authenticated GraphQL client (so the session token
 * never appears in a URL), opens the backend OAuth start URL in an auth
 * session browser, then reads the `status` query param off the final redirect.
 *
 * - Handoff mint fails (signed out, offline) → 'error'.
 * - Browser dismissed / cancelled → 'cancelled'.
 * - status=connected → tracks the connection and returns 'connected'.
 * - any other status (including status=error) → 'error'.
 *
 * Never throws — every failure maps to a result the caller can render.
 */
export async function connectStrava(): Promise<StravaConnectResult> {
  let handoff: string;
  try {
    const response = await getHttpClient().request<CreateIntegrationOAuthHandoffResponse>(
      CREATE_INTEGRATION_OAUTH_HANDOFF,
      { provider: 'STRAVA' },
    );
    handoff = response.createIntegrationOAuthHandoff;
  } catch (error) {
    reportHandledError(error, { tags: { source: 'integration', op: 'strava-connect', step: 'handoff' } });
    return 'error';
  }
  if (!handoff) return 'error';

  const startUrl = `${BACKEND_URL}/integrations/strava/start?handoff=${encodeURIComponent(handoff)}`;

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(startUrl, STRAVA_REDIRECT_URL);
  } catch (error) {
    reportHandledError(error, { tags: { source: 'integration', op: 'strava-connect', step: 'auth-session' } });
    return 'error';
  }

  if (result.type !== 'success') return 'cancelled';

  const status = readStatusParam(result.url);
  if (status === 'connected') {
    track(SHARED_EVENTS.IntegrationConnected, { integration: 'strava' });
    return 'connected';
  }
  return 'error';
}

/** Extract the `status` query param from the OAuth redirect URL. Returns null
 *  when the URL is unparseable or carries no status. */
function readStatusParam(redirectUrl: string): string | null {
  return parseDeepLinkQueryParams(redirectUrl).get('status') ?? null;
}
