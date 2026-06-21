// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
//
// Covers the browser-navigation OAuth handlers end to end at the handler level:
// handoff verification (including purpose confusion and Redis single-use),
// state verification, the constrained error-reason allowlist, the granted-scope
// check (with Strava's space-after-comma form), and the exchange/persist
// failure redirects. This is the most security-sensitive surface of the
// integrations feature — every branch below is an authentication or
// open-redirect decision.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

process.env.NEXTAUTH_SECRET = 'test-secret-for-oauth-handlers';
process.env.BACKEND_PUBLIC_URL = 'https://backend.test';

// --- credentials mock ---------------------------------------------------------
const upsertCredential = vi.fn();
vi.mock('../integrations/credentials', () => ({
  upsertCredential: (...args) => upsertCredential(...args),
}));

// --- redis mock ----------------------------------------------------------------
// Default: disconnected (single-use degrades to HMAC expiry). Tests flip
// `redisState.connected` and control `redisState.setResults` per call.
const redisState = { connected: false, setResults: [] };
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({
      publisher: {
        // `null` is a meaningful queued value (ioredis returns null when SET NX
        // loses), so only default to 'OK' when the queue is exhausted.
        set: vi.fn(() => {
          const queued = redisState.setResults.length > 0 ? redisState.setResults.shift() : 'OK';
          return Promise.resolve(queued);
        }),
      },
    }),
  },
}));

// --- provider mock ---------------------------------------------------------------
// Real registry (isSupportedProvider, enum maps) with only getProvider faked so
// no test needs STRAVA_CLIENT_ID or live fetch.
const exchangeCode = vi.fn();
vi.mock('../integrations/registry', async () => {
  const actual = await vi.importActual('../integrations/registry');
  return {
    ...actual,
    getProvider: vi.fn((name) =>
      name === 'strava'
        ? {
            provider: 'strava',
            buildAuthorizeUrl: (state, redirectUri) =>
              `https://www.strava.com/oauth/mobile/authorize?client_id=test&redirect_uri=${encodeURIComponent(
                redirectUri,
              )}&state=${encodeURIComponent(state)}`,
            exchangeCode: (...args) => exchangeCode(...args),
            activityUrl: (id) => `https://www.strava.com/activities/${id}`,
          }
        : null,
    ),
  };
});

import { handleIntegrationOAuthStart, handleIntegrationOAuthCallback } from '../handlers/integrations-oauth';
import { signIntegrationHandoff, signIntegrationState, verifyIntegrationState } from '../integrations/state';

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      res.statusCode = statusCode;
      res.headers = headers ?? {};
    },
    end(body) {
      res.body = body ?? null;
    },
  };
  return res;
}

function startUrl(query) {
  return new URL(`https://backend.test/integrations/strava/start${query}`);
}

function callbackUrl(query) {
  return new URL(`https://backend.test/integrations/strava/callback${query}`);
}

const VALID_TOKENS = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: new Date('2026-07-01T00:00:00.000Z'),
  externalAccountId: '777',
  externalAccountName: 'climber',
  scopes: 'read,activity:write',
};

describe('handleIntegrationOAuthStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.connected = false;
    redisState.setResults = [];
  });

  it('404s an unknown provider path segment', async () => {
    const res = makeRes();
    await handleIntegrationOAuthStart({}, res, 'garmin', startUrl('?handoff=x'));
    expect(res.statusCode).toBe(404);
  });

  it('401s a missing handoff', async () => {
    const res = makeRes();
    await handleIntegrationOAuthStart({}, res, 'strava', startUrl(''));
    expect(res.statusCode).toBe(401);
  });

  it('401s a garbage handoff', async () => {
    const res = makeRes();
    await handleIntegrationOAuthStart({}, res, 'strava', startUrl('?handoff=not-a-token'));
    expect(res.statusCode).toBe(401);
  });

  it('401s an OAuth state token presented as a handoff (purpose confusion)', async () => {
    const stateAsHandoff = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    const res = makeRes();
    await handleIntegrationOAuthStart({}, res, 'strava', startUrl(`?handoff=${encodeURIComponent(stateAsHandoff)}`));
    expect(res.statusCode).toBe(401);
  });

  it('redirects a valid handoff to the provider with a state carrying the same userId', async () => {
    const handoff = signIntegrationHandoff({ userId: 'user-42', provider: 'strava' });
    const res = makeRes();
    await handleIntegrationOAuthStart({}, res, 'strava', startUrl(`?handoff=${encodeURIComponent(handoff)}`));

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.Location);
    expect(location.origin).toBe('https://www.strava.com');
    expect(location.searchParams.get('redirect_uri')).toBe('https://backend.test/integrations/strava/callback');
    const verifiedState = verifyIntegrationState(location.searchParams.get('state'));
    expect(verifiedState).toMatchObject({ userId: 'user-42', provider: 'strava' });
  });

  it('rejects a replayed handoff when Redis enforces single-use', async () => {
    redisState.connected = true;
    redisState.setResults = ['OK', null]; // first consume wins, second loses
    const handoff = signIntegrationHandoff({ userId: 'user-42', provider: 'strava' });

    const firstRes = makeRes();
    await handleIntegrationOAuthStart({}, firstRes, 'strava', startUrl(`?handoff=${encodeURIComponent(handoff)}`));
    expect(firstRes.statusCode).toBe(302);

    const replayRes = makeRes();
    await handleIntegrationOAuthStart({}, replayRes, 'strava', startUrl(`?handoff=${encodeURIComponent(handoff)}`));
    expect(replayRes.statusCode).toBe(401);
  });
});

describe('handleIntegrationOAuthCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.connected = false;
    redisState.setResults = [];
  });

  function expectDeepLinkError(res, reason) {
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe(
      `com.boardsesh.app://integrations/strava?status=error&reason=${encodeURIComponent(reason)}`,
    );
  }

  it('404s an unknown provider path segment', async () => {
    const res = makeRes();
    await handleIntegrationOAuthCallback({}, res, 'garmin', callbackUrl('?code=x&state=y'));
    expect(res.statusCode).toBe(404);
  });

  it('reflects a known provider error through the allowlist', async () => {
    const res = makeRes();
    await handleIntegrationOAuthCallback({}, res, 'strava', callbackUrl('?error=access_denied'));
    expectDeepLinkError(res, 'access_denied');
  });

  it('collapses an unknown provider error to oauth_error (no attacker-controlled reflection)', async () => {
    const res = makeRes();
    await handleIntegrationOAuthCallback({}, res, 'strava', callbackUrl('?error=%22%3E%3Cscript%3E'));
    expectDeepLinkError(res, 'oauth_error');
  });

  it('redirects state_invalid when state is missing or garbage', async () => {
    const missingRes = makeRes();
    await handleIntegrationOAuthCallback({}, missingRes, 'strava', callbackUrl('?code=abc'));
    expectDeepLinkError(missingRes, 'state_invalid');

    const garbageRes = makeRes();
    await handleIntegrationOAuthCallback({}, garbageRes, 'strava', callbackUrl('?code=abc&state=garbage'));
    expectDeepLinkError(garbageRes, 'state_invalid');
  });

  it('rejects a handoff token presented as state (purpose confusion)', async () => {
    const handoffAsState = signIntegrationHandoff({ userId: 'user-1', provider: 'strava' });
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&state=${encodeURIComponent(handoffAsState)}`),
    );
    expectDeepLinkError(res, 'state_invalid');
  });

  it('redirects missing_params when the code is absent', async () => {
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    const res = makeRes();
    await handleIntegrationOAuthCallback({}, res, 'strava', callbackUrl(`?state=${encodeURIComponent(state)}`));
    expectDeepLinkError(res, 'missing_params');
  });

  it('redirects missing_scope when activity:write was not granted', async () => {
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&scope=read&state=${encodeURIComponent(state)}`),
    );
    expectDeepLinkError(res, 'missing_scope');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('accepts a granted scope with spaces after commas', async () => {
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    exchangeCode.mockResolvedValueOnce(VALID_TOKENS);
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&scope=${encodeURIComponent('read, activity:write')}&state=${encodeURIComponent(state)}`),
    );
    expect(res.headers.Location).toBe('com.boardsesh.app://integrations/strava?status=connected');
  });

  it('redirects exchange_failed (and persists nothing) when the code exchange throws', async () => {
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    exchangeCode.mockRejectedValueOnce(new Error('upstream 500'));
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&scope=read,activity:write&state=${encodeURIComponent(state)}`),
    );
    expectDeepLinkError(res, 'exchange_failed');
    expect(upsertCredential).not.toHaveBeenCalled();
  });

  it('redirects persist_failed when storing the credential throws', async () => {
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    exchangeCode.mockResolvedValueOnce(VALID_TOKENS);
    upsertCredential.mockRejectedValueOnce(new Error('db down'));
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&scope=read,activity:write&state=${encodeURIComponent(state)}`),
    );
    expectDeepLinkError(res, 'persist_failed');
  });

  it('persists the credential for the state userId and deep-links connected', async () => {
    const state = signIntegrationState({ userId: 'user-42', provider: 'strava' });
    exchangeCode.mockResolvedValueOnce(VALID_TOKENS);
    const res = makeRes();
    await handleIntegrationOAuthCallback(
      {},
      res,
      'strava',
      callbackUrl(`?code=abc&scope=read,activity:write&state=${encodeURIComponent(state)}`),
    );

    expect(exchangeCode).toHaveBeenCalledWith('abc', 'https://backend.test/integrations/strava/callback');
    expect(upsertCredential).toHaveBeenCalledWith('user-42', 'strava', VALID_TOKENS);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('com.boardsesh.app://integrations/strava?status=connected');
  });
});
