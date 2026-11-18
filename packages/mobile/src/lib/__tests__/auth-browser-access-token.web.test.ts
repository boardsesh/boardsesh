// @vitest-environment jsdom
/**
 * #7596 B3b on app.boardsesh.com: ws-auth answers a 15-minute browser access
 * token with its end (`expiresAt`) under `better-auth`. The page refreshes it
 * about three minutes before the end, keeps it through a failed refresh while
 * it lasts, and treats a ws-auth 401 as "read the session again". The legacy
 * JWE (no `expiresAt`) is never refreshed on a timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, getAuthToken, isTokenExpiringSoon, synchronizeWebSession } from '../auth-store.web';
import { ensureFreshToken } from '../auth-interceptor.web';

const WEB = 'https://www.boardsesh.com';

vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
// The real client-identity.web module runs; only its version source is pinned.
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '2.6.0' } } }));
const MINUTE_MS = 60_000;
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const sessionRead = () => jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' });
const browserToken = (token: string, minutes = 15) =>
  jsonResponse({
    authenticated: true,
    token,
    userId: 'user-1',
    authSessionId: 'login-1',
    expiresAt: new Date(Date.now() + minutes * MINUTE_MS).toISOString(),
    expiresIn: minutes * 60,
  });

/** The same answer a server with a correct clock gives: `expiresAt` in server time, `expiresIn` in seconds. */
const browserTokenFromServer = (token: string) =>
  jsonResponse({
    authenticated: true,
    token,
    userId: 'user-1',
    authSessionId: 'login-1',
    expiresAt: '2026-11-18T12:15:00.000Z',
    expiresIn: 15 * 60,
  });

function wsAuthCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => url === `${WEB}/api/internal/ws-auth`).length;
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // No jitter, so the refresh comes exactly three minutes before the end.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  fetchMock.mockReset();
  await clearTokens();
});

afterEach(async () => {
  await clearTokens();
  vi.useRealTimers();
  vi.mocked(Math.random).mockRestore();
});

describe('a 15-minute browser access token on Expo web', () => {
  it('is refreshed about three minutes before its end through one shared session read', async () => {
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserToken('browser-token-1'));
    await synchronizeWebSession();
    await expect(getAuthToken()).resolves.toBe('browser-token-1');
    await expect(isTokenExpiringSoon()).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserToken('browser-token-2'));
    await vi.advanceTimersByTimeAsync(11 * MINUTE_MS);
    expect(wsAuthCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE_MS + 1000);
    await vi.waitFor(async () => expect(await getAuthToken()).toBe('browser-token-2'));
    expect(wsAuthCalls()).toBe(2);
  });

  it('keeps a token that has not ended through a failed refresh, and never signs the page out', async () => {
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserToken('browser-token-1'));
    await synchronizeWebSession();
    await vi.advanceTimersByTimeAsync(12 * MINUTE_MS + 1000);
    await expect(isTokenExpiringSoon()).resolves.toBe(true);
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Credential authority is temporarily unavailable' }, 503));
    await expect(ensureFreshToken()).resolves.toBe(true);
    await expect(getAuthToken()).resolves.toBe('browser-token-1');
    // Backing off: the next requests send the held token and read nothing.
    const sessionReadsBefore = fetchMock.mock.calls.length;
    await expect(ensureFreshToken()).resolves.toBe(true);
    await expect(ensureFreshToken()).resolves.toBe(true);
    expect(fetchMock.mock.calls.length).toBe(sessionReadsBefore);
    // Past its end, a failed refresh has nothing left to send.
    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    await expect(ensureFreshToken()).resolves.toBe(false);
  });

  it.each([
    ['15 minutes fast', 15 * MINUTE_MS],
    ['15 minutes slow', -15 * MINUTE_MS],
  ])('with a client clock %s refreshes 12 minutes after receipt, not before', async (_label, skewMs) => {
    vi.setSystemTime(Date.now() + skewMs);
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserTokenFromServer('browser-token-1'));
    await synchronizeWebSession();
    await expect(isTokenExpiringSoon()).resolves.toBe(false);
    await expect(ensureFreshToken()).resolves.toBe(true);
    expect(wsAuthCalls()).toBe(1);
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserTokenFromServer('browser-token-2'));
    await vi.advanceTimersByTimeAsync(11 * MINUTE_MS);
    expect(wsAuthCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE_MS + 1000);
    await vi.waitFor(async () => expect(await getAuthToken()).toBe('browser-token-2'));
  });

  it('does not refresh in a hidden tab; refreshes when the tab is shown', async () => {
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserToken('browser-token-1'));
    await synchronizeWebSession();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(12 * MINUTE_MS + 1000);
    expect(wsAuthCalls()).toBe(1);
    fetchMock.mockResolvedValueOnce(sessionRead()).mockResolvedValueOnce(browserToken('browser-token-2'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(async () => expect(await getAuthToken()).toBe('browser-token-2'));
    visibility.mockRestore();
  });

  it('reads the session again when ws-auth answers 401, and follows it to signed out', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionRead())
      .mockResolvedValueOnce(jsonResponse({ token: null, authenticated: false }, 401))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(synchronizeWebSession()).resolves.toEqual({ status: 'anonymous' });
    await expect(getAuthToken()).resolves.toBeNull();
  });
});

describe('the legacy JWE (mode off)', () => {
  it('has no end, so it is never refreshed on a timer and never reads as expiring', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionRead())
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, token: 'nextauth-jwe', userId: 'user-1', authSessionId: 'login-1' }),
      );
    await synchronizeWebSession();
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(wsAuthCalls()).toBe(1);
    await expect(isTokenExpiringSoon()).resolves.toBe(false);
    await expect(ensureFreshToken()).resolves.toBe(true);
    expect(wsAuthCalls()).toBe(1);
  });
});
