// Strava OAuth + activity-upload provider. Plain `fetch`, no SDK. Env is read
// lazily inside each function so tests can stub STRAVA_CLIENT_ID / _SECRET.

import type { IntegrationProviderImpl, ProviderTokens, SessionActivityInput } from './types';
import { logger } from '../utils/logger';

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/mobile/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize';
const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/activities';

function stravaActivityUrl(externalActivityId: string): string {
  return `https://www.strava.com/activities/${externalActivityId}`;
}

/** Scopes we request: read profile + write activities. */
const STRAVA_SCOPE = 'read,activity:write';

/**
 * Thrown when a provider HTTP call returns a non-2xx response. `statusCode`
 * lets callers distinguish an expired token (401) from a transient failure so
 * they can mark the credential expired vs. leave it active for retry.
 */
export class IntegrationHttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'IntegrationHttpError';
    this.statusCode = statusCode;
  }
}

function getStravaCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Strava integration is not configured (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET unset)');
  }
  return { clientId, clientSecret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a JSON body, returning a clear error rather than a TypeError when the
 * provider returns a 200 with a malformed/non-JSON payload.
 */
async function parseJsonBody(response: Response, context: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Strava ${context}: response body was not valid JSON`);
  }
  if (!isRecord(body)) {
    throw new Error(`Strava ${context}: response body was not an object`);
  }
  return body;
}

/** Derive a display name from a Strava athlete object. */
function athleteDisplayName(athlete: Record<string, unknown>): string | null {
  const username = athlete.username;
  if (typeof username === 'string' && username.length > 0) {
    return username;
  }
  const firstName = typeof athlete.firstname === 'string' ? athlete.firstname : '';
  const lastName = typeof athlete.lastname === 'string' ? athlete.lastname : '';
  const combined = `${firstName} ${lastName}`.trim();
  return combined.length > 0 ? combined : null;
}

/** Map a token-endpoint JSON body to ProviderTokens, shape-guarding every field. */
function tokensFromTokenResponse(body: Record<string, unknown>, context: string): ProviderTokens {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const expiresAt = body.expires_at;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error(`Strava ${context}: missing access_token or refresh_token`);
  }
  if (typeof expiresAt !== 'number') {
    throw new Error(`Strava ${context}: missing or non-numeric expires_at`);
  }

  let externalAccountId = '';
  let externalAccountName: string | null = null;
  // The athlete object is only present on the initial code exchange, not on
  // refresh. Both are surfaced through this mapper, so treat it as optional.
  if (isRecord(body.athlete)) {
    const athlete = body.athlete;
    if (typeof athlete.id === 'number') {
      externalAccountId = String(athlete.id);
    } else if (typeof athlete.id === 'string') {
      externalAccountId = athlete.id;
    }
    externalAccountName = athleteDisplayName(athlete);
  }

  return {
    accessToken,
    refreshToken,
    // Strava returns epoch *seconds*.
    expiresAt: new Date(expiresAt * 1000),
    externalAccountId,
    externalAccountName,
    scopes: STRAVA_SCOPE,
  };
}

async function requestStravaTokens(params: Record<string, string>, context: string): Promise<Record<string, unknown>> {
  const { clientId, clientSecret } = getStravaCredentials();
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...params,
  });

  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!response.ok) {
    throw new IntegrationHttpError(`Strava ${context} failed with status ${response.status}`, response.status);
  }

  return parseJsonBody(response, context);
}

export const stravaProvider: IntegrationProviderImpl = {
  provider: 'strava',

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const { clientId } = getStravaCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: STRAVA_SCOPE,
      state,
    });
    return `${STRAVA_AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(code: string, redirectUri: string): Promise<ProviderTokens> {
    const body = await requestStravaTokens(
      {
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
      'code exchange',
    );
    return tokensFromTokenResponse(body, 'code exchange');
  },

  async refreshTokens(
    refreshToken: string,
  ): Promise<Pick<ProviderTokens, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
    const body = await requestStravaTokens(
      {
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
      'token refresh',
    );
    const tokens = tokensFromTokenResponse(body, 'token refresh');
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  },

  async uploadSessionActivity(
    accessToken: string,
    activity: SessionActivityInput,
  ): Promise<{ externalActivityId: string; url: string }> {
    const form = new URLSearchParams({
      name: activity.name,
      sport_type: 'RockClimbing',
      start_date_local: activity.startDateLocal,
      elapsed_time: String(activity.elapsedSeconds),
      description: activity.description,
      trainer: '0',
      commute: '0',
    });

    const response = await fetch(STRAVA_ACTIVITIES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!response.ok) {
      throw new IntegrationHttpError(`Strava activity upload failed with status ${response.status}`, response.status);
    }

    const body = await parseJsonBody(response, 'activity upload');
    const activityId = body.id;
    if (typeof activityId !== 'number') {
      throw new Error('Strava activity upload: response missing numeric id');
    }
    const externalActivityId = String(activityId);
    return {
      externalActivityId,
      url: stravaActivityUrl(externalActivityId),
    };
  },

  activityUrl: stravaActivityUrl,

  async revoke(accessToken: string): Promise<void> {
    // Best-effort per the interface contract: a failed deauthorize must never
    // throw — the local disconnect proceeds regardless, so the only useful
    // output here is a diagnostic log.
    try {
      const form = new URLSearchParams({ access_token: accessToken });
      const response = await fetch(STRAVA_DEAUTHORIZE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!response.ok) {
        logger.warn(`[Integrations] Strava deauthorize returned status ${response.status}`);
      }
    } catch (error) {
      logger.warn('[Integrations] Strava deauthorize request failed:', error);
    }
  },
};
