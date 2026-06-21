// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
//
// Covers the token-refresh concurrency contract of getFreshAccessToken: the
// row is re-read at entry, the persist is optimistically locked on the stored
// refresh-token ciphertext, and a 400/401 refresh failure checks for a
// concurrent winner before marking the credential expired.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// --- db mock ----------------------------------------------------------------
// Successive select(...).from(...).where(...).limit(...) chains consume
// `selectResults` in call order (getFreshAccessToken re-reads the row at entry
// and again on a failed refresh). update(...).set(...).where(...) records calls.
const selectResults = [];
let selectIndex = 0;
const updateCalls = [];

vi.mock('../db/client', () => {
  const db = {
    select: vi.fn(() => {
      const current = selectIndex++;
      const resolved = selectResults[current] ?? [];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(resolved)) })),
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values) => ({
        where: vi.fn(() => {
          updateCalls.push({ set: values });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return { db };
});

// Identity "encryption" so ciphertext comparisons stay readable in fixtures.
vi.mock('@boardsesh/crypto', () => ({
  encrypt: (value) => `enc:${value}`,
  decrypt: (value) => value.replace(/^enc:/, ''),
}));

const refreshTokens = vi.fn();
vi.mock('../integrations/registry', async () => {
  const actual = await vi.importActual('../integrations/registry');
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      provider: 'strava',
      refreshTokens: (...args) => refreshTokens(...args),
    })),
  };
});

import { IntegrationHttpError } from '../integrations/strava';
import { getFreshAccessToken } from '../integrations/credentials';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function credRow(overrides = {}) {
  return {
    id: 1n,
    userId: 'user-1',
    provider: 'strava',
    encryptedAccessToken: 'enc:stale-access',
    encryptedRefreshToken: 'enc:stale-refresh',
    tokenExpiresAt: PAST,
    status: 'active',
    ...overrides,
  };
}

describe('getFreshAccessToken', () => {
  beforeEach(() => {
    selectResults.length = 0;
    selectIndex = 0;
    updateCalls.length = 0;
    vi.clearAllMocks();
  });

  it("uses a concurrent refresher's token when the re-read shows it is already fresh", async () => {
    // The caller holds a stale row, but another request refreshed in between:
    // the re-read returns fresh tokens, so no provider call happens at all.
    selectResults.push([
      credRow({
        encryptedAccessToken: 'enc:winner-access',
        encryptedRefreshToken: 'enc:winner-refresh',
        tokenExpiresAt: FUTURE,
      }),
    ]);

    const accessToken = await getFreshAccessToken(credRow());

    expect(accessToken).toBe('winner-access');
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('refreshes an expiring token and persists the rotation', async () => {
    selectResults.push([credRow()]);
    refreshTokens.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: FUTURE,
    });

    const accessToken = await getFreshAccessToken(credRow());

    expect(accessToken).toBe('new-access');
    expect(refreshTokens).toHaveBeenCalledWith('stale-refresh');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set.encryptedRefreshToken).toBe('enc:new-refresh');
    expect(updateCalls[0].set.status).toBe('active');
  });

  it("recovers from a 401 refresh by returning a concurrent winner's token instead of expiring the credential", async () => {
    // Our refresh token was already used (and rotated) by a concurrent
    // request, so the provider rejects it — but the re-read shows the winner's
    // tokens, which are good to use.
    selectResults.push([credRow()]);
    selectResults.push([
      credRow({
        encryptedAccessToken: 'enc:winner-access',
        encryptedRefreshToken: 'enc:winner-refresh',
        tokenExpiresAt: FUTURE,
      }),
    ]);
    refreshTokens.mockRejectedValueOnce(new IntegrationHttpError('invalid_grant', 400));

    const accessToken = await getFreshAccessToken(credRow());

    expect(accessToken).toBe('winner-access');
    expect(updateCalls.some((call) => call.set.status === 'expired')).toBe(false);
  });

  it('marks the credential expired on a 401 refresh with no concurrent winner', async () => {
    selectResults.push([credRow()]);
    selectResults.push([credRow()]); // re-read: unchanged, nobody else refreshed
    refreshTokens.mockRejectedValueOnce(new IntegrationHttpError('unauthorized', 401));

    await expect(getFreshAccessToken(credRow())).rejects.toThrow('unauthorized');
    expect(updateCalls.some((call) => call.set.status === 'expired')).toBe(true);
  });
});
