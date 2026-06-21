// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

process.env.STRAVA_CLIENT_ID = 'test-client-id';
process.env.STRAVA_CLIENT_SECRET = 'test-client-secret';

import { stravaProvider, IntegrationHttpError } from '../integrations/strava';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function textOkResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('not json')),
    text: () => Promise.resolve(text),
  };
}

describe('stravaProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('buildAuthorizeUrl', () => {
    it('includes the required params and scope', () => {
      const url = stravaProvider.buildAuthorizeUrl('state-123', 'https://backend.test/integrations/strava/callback');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://www.strava.com/oauth/mobile/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://backend.test/integrations/strava/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('approval_prompt')).toBe('auto');
      expect(parsed.searchParams.get('scope')).toBe('read,activity:write');
      expect(parsed.searchParams.get('state')).toBe('state-123');
    });
  });

  describe('exchangeCode', () => {
    it('maps token fields and prefers athlete.username for the display name', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_at: 1_700_000_000,
          athlete: { id: 999, username: 'climber99', firstname: 'Ada', lastname: 'Lovelace' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const tokens = await stravaProvider.exchangeCode('code-1', 'https://backend.test/cb');
      expect(tokens.accessToken).toBe('access-1');
      expect(tokens.refreshToken).toBe('refresh-1');
      expect(tokens.expiresAt.getTime()).toBe(1_700_000_000 * 1000);
      expect(tokens.externalAccountId).toBe('999');
      expect(tokens.externalAccountName).toBe('climber99');
      expect(tokens.scopes).toBe('read,activity:write');

      // Form-encoded body carries the grant params.
      const [, init] = fetchMock.mock.calls[0];
      const body = new URLSearchParams(init.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('client_secret')).toBe('test-client-secret');
    });

    it('falls back to firstname + lastname when username is absent', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          jsonResponse({
            access_token: 'a',
            refresh_token: 'r',
            expires_at: 1_700_000_000,
            athlete: { id: 1, firstname: 'Ada', lastname: 'Lovelace' },
          }),
        ),
      );
      const tokens = await stravaProvider.exchangeCode('code', 'https://backend.test/cb');
      expect(tokens.externalAccountName).toBe('Ada Lovelace');
    });

    it('throws a clear error when the body is malformed (200 but missing tokens)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ unexpected: true })));
      await expect(stravaProvider.exchangeCode('code', 'https://backend.test/cb')).rejects.toThrow(
        /missing access_token/,
      );
    });

    it('throws a clear error when the body is not valid JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textOkResponse('<html>nope</html>')));
      await expect(stravaProvider.exchangeCode('code', 'https://backend.test/cb')).rejects.toThrow(/not valid JSON/);
    });
  });

  describe('refreshTokens', () => {
    it('returns the rotated refresh token and new expiry', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          jsonResponse({
            access_token: 'access-2',
            refresh_token: 'refresh-rotated',
            expires_at: 1_800_000_000,
          }),
        ),
      );
      const refreshed = await stravaProvider.refreshTokens('old-refresh');
      expect(refreshed.accessToken).toBe('access-2');
      expect(refreshed.refreshToken).toBe('refresh-rotated');
      expect(refreshed.expiresAt.getTime()).toBe(1_800_000_000 * 1000);
    });
  });

  describe('uploadSessionActivity', () => {
    it('sends the exact form fields and parses the activity id', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 555123 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await stravaProvider.uploadSessionActivity('access-token', {
        name: 'Kilter Board session — 3 sends',
        description: 'Logged with Boardsesh',
        startDateLocal: '2026-06-11T10:00:00.000Z',
        elapsedSeconds: 3600,
      });

      expect(result.externalActivityId).toBe('555123');
      expect(result.url).toBe('https://www.strava.com/activities/555123');

      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe('https://www.strava.com/api/v3/activities');
      expect(init.headers.Authorization).toBe('Bearer access-token');
      const body = new URLSearchParams(init.body);
      expect(body.get('name')).toBe('Kilter Board session — 3 sends');
      expect(body.get('sport_type')).toBe('RockClimbing');
      expect(body.get('start_date_local')).toBe('2026-06-11T10:00:00.000Z');
      expect(body.get('elapsed_time')).toBe('3600');
      expect(body.get('description')).toBe('Logged with Boardsesh');
      expect(body.get('trainer')).toBe('0');
      expect(body.get('commute')).toBe('0');
    });

    it('throws IntegrationHttpError with statusCode 401 on an expired token', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Authorization Error' }, 401)));
      const error = await stravaProvider
        .uploadSessionActivity('access-token', {
          name: 'x',
          description: 'y',
          startDateLocal: '2026-06-11T10:00:00.000Z',
          elapsedSeconds: 10,
        })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(IntegrationHttpError);
      expect(error.statusCode).toBe(401);
    });
  });
});
