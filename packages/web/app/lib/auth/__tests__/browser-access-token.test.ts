// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ACCESS_TOKEN_REFRESH_LEAD_MS,
  MAX_ACCESS_TOKEN_BACKOFF_MS,
  MIN_ACCESS_TOKEN_REFRESH_DELAY_MS,
  accessTokenBackoff,
  accessTokenNeedsRefresh,
  accessTokenRefreshInterval,
  accessTokenStaleTime,
  noteAccessTokenRefreshFailed,
  isBrowserAccessToken,
  noteSocketClosed,
  refreshAccessTokenAfterCredentialChange,
  refreshAfterRefusal,
  registerAccessTokenRefresher,
  rememberBrowserAccessToken,
  resetBrowserAccessTokensForTests,
  socketConnectToken,
  socketCredentialHandle,
} from '../browser-access-token';
import { createSessionGuard } from '../session-guard';

const viewerA = { userId: 'user-a', authSessionId: 'login-a' };
const viewerB = { userId: 'user-b', authSessionId: 'login-b' };
const MINUTE_MS = 60_000;
/** ws-auth's `expiresIn` for a fresh 15-minute token. */
const FIFTEEN_MINUTES = 15 * 60;

/** A ws-auth that hands out `token-2`, `token-3`, ... for viewer A, counting its calls. */
function issuingRefresher(viewer = viewerA) {
  let issued = 1;
  const refresher = vi.fn(async () => {
    issued += 1;
    rememberBrowserAccessToken(`token-${issued}`, viewer, FIFTEEN_MINUTES);
  });
  registerAccessTokenRefresher(refresher);
  return refresher;
}

beforeEach(() => resetBrowserAccessTokensForTests());
afterEach(() => vi.useRealTimers());

describe('refresh timing', () => {
  it('goes stale three minutes (and its jitter) before its end, counted from receipt, never under 30 s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const receivedAt = 1_000_000;
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES, receivedAt);
    // 15 min - 3 min - 15 s of jitter, whatever the client clock says the time is.
    expect(accessTokenStaleTime('token-1', FIFTEEN_MINUTES * 1000, receivedAt)).toBe(12 * MINUTE_MS - 15_000);
    expect(accessTokenRefreshInterval('token-1', FIFTEEN_MINUTES * 1000, receivedAt, receivedAt)).toBe(
      12 * MINUTE_MS - 15_000,
    );
    // A token capped by a session ending in a minute: no refresh storm.
    expect(accessTokenStaleTime('token-1', MINUTE_MS, receivedAt)).toBe(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS);
    vi.mocked(Math.random).mockRestore();
  });

  it('a client clock 15 minutes fast or slow changes nothing: only time since receipt counts', () => {
    vi.useFakeTimers();
    for (const skewMs of [15 * MINUTE_MS, -15 * MINUTE_MS]) {
      resetBrowserAccessTokensForTests();
      vi.setSystemTime(Date.UTC(2026, 10, 18, 12) + skewMs);
      rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
      expect(accessTokenNeedsRefresh()).toBe(false);
      vi.advanceTimersByTime(11 * MINUTE_MS);
      expect(accessTokenNeedsRefresh()).toBe(false);
      vi.advanceTimersByTime(MINUTE_MS + 1);
      expect(accessTokenNeedsRefresh()).toBe(true);
    }
  });

  it('after failed refreshes waits 30 s, then 60 s, doubling per failure up to five minutes', () => {
    const receivedAt = 1_000_000;
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES, receivedAt);
    const refreshDue = receivedAt + 12 * MINUTE_MS;
    noteAccessTokenRefreshFailed(refreshDue);
    expect(accessTokenRefreshInterval('token-1', FIFTEEN_MINUTES * 1000, receivedAt, refreshDue)).toBe(30_000);
    noteAccessTokenRefreshFailed(refreshDue + 30_000);
    expect(accessTokenRefreshInterval('token-1', FIFTEEN_MINUTES * 1000, receivedAt, refreshDue + 30_000)).toBe(60_000);
  });

  it('backs off after failed refreshes, up to five minutes', () => {
    expect(accessTokenBackoff(0)).toBe(0);
    expect(accessTokenBackoff(1)).toBe(30_000);
    expect(accessTokenBackoff(2)).toBe(60_000);
    expect(accessTokenBackoff(20)).toBe(MAX_ACCESS_TOKEN_BACKOFF_MS);
  });

  it('needs a refresh only inside the last three minutes', () => {
    vi.useFakeTimers();
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    expect(accessTokenNeedsRefresh()).toBe(false);
    vi.advanceTimersByTime(15 * MINUTE_MS - ACCESS_TOKEN_REFRESH_LEAD_MS);
    expect(accessTokenNeedsRefresh()).toBe(true);
  });
});

describe('with the mode off (a token without an end)', () => {
  it('remembers nothing, so requests and sockets send the token exactly as before', async () => {
    const refresher = issuingRefresher();
    rememberBrowserAccessToken('nextauth-jwe', viewerA, undefined);
    expect(isBrowserAccessToken('nextauth-jwe')).toBe(false);
    expect(socketCredentialHandle('nextauth-jwe')).toBe('nextauth-jwe');
    noteSocketClosed('nextauth-jwe', 4401);
    await expect(socketConnectToken('nextauth-jwe')).resolves.toBe('nextauth-jwe');
    await expect(refreshAfterRefusal('nextauth-jwe')).resolves.toBeUndefined();
    expect(refresher).not.toHaveBeenCalled();
  });
});

describe('after the backend refuses a token', () => {
  it('fetches ONE new token for every caller refused at once, and only once per token', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    let finishRefresh!: () => void;
    const held = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refresher = vi.fn(async () => {
      await held;
      rememberBrowserAccessToken('token-2', viewerA, FIFTEEN_MINUTES);
    });
    registerAccessTokenRefresher(refresher);
    const answers = Promise.all([1, 2, 3].map(() => refreshAfterRefusal('token-1')));
    expect(refresher).toHaveBeenCalledTimes(1);
    finishRefresh();
    await expect(answers).resolves.toEqual(['token-2', 'token-2', 'token-2']);
    expect(refresher).toHaveBeenCalledTimes(1);
    // A late refusal of the old token uses the new one without another fetch.
    await expect(refreshAfterRefusal('token-1')).resolves.toBe('token-2');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('gives up (and leaves it to the session guard) when the new token brings nothing new', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    // ws-auth keeps failing: the refresh brings no token.
    const refresher = vi.fn(async () => {});
    registerAccessTokenRefresher(refresher);
    await expect(refreshAfterRefusal('token-1')).resolves.toBeUndefined();
    await expect(refreshAfterRefusal('token-1')).resolves.toBeUndefined();
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('after set-password or a provider link fetches a new token at once', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    const refresher = issuingRefresher();
    await refreshAccessTokenAfterCredentialChange();
    expect(refresher).toHaveBeenCalledTimes(1);
    // A request still holding the dead token is retried with the new one, without another fetch.
    await expect(refreshAfterRefusal('token-1')).resolves.toBe('token-2');
    expect(refresher).toHaveBeenCalledTimes(1);
  });
});

describe('a socket', () => {
  it('keeps one handle while the viewer does and connects with the current token', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    rememberBrowserAccessToken('token-2', viewerA, FIFTEEN_MINUTES);
    expect(socketCredentialHandle('token-2')).toBe('token-1');
    await expect(socketConnectToken('token-1')).resolves.toBe('token-2');
  });

  it('keeps the handle and the latest 31 tokens through repeated refreshes', async () => {
    const tokens = Array.from({ length: 65 }, (_, index) => `token-${index}`);
    for (const token of tokens) rememberBrowserAccessToken(token, viewerA, FIFTEEN_MINUTES);

    expect(tokens.filter(isBrowserAccessToken)).toEqual([tokens[0], ...tokens.slice(-31)]);
    await expect(socketConnectToken(tokens[0])).resolves.toBe(tokens.at(-1));
  });

  it('asks for a new token after a 4401, and reconnects with the same token after a 1013', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    const refresher = issuingRefresher();
    noteSocketClosed('token-1', 1013);
    await expect(socketConnectToken('token-1')).resolves.toBe('token-1');
    expect(refresher).not.toHaveBeenCalled();
    noteSocketClosed('token-1', 4401);
    await expect(socketConnectToken('token-1')).resolves.toBe('token-2');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('refreshes a token inside its last three minutes before the handshake', async () => {
    vi.useFakeTimers();
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    const refresher = issuingRefresher();
    vi.advanceTimersByTime(13 * MINUTE_MS);
    await expect(socketConnectToken('token-1')).resolves.toBe('token-2');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('forgets every token of an account that is gone', async () => {
    rememberBrowserAccessToken('token-a', viewerA, FIFTEEN_MINUTES);
    rememberBrowserAccessToken('token-b', viewerB, FIFTEEN_MINUTES);
    expect(isBrowserAccessToken('token-a')).toBe(false);
    // A stale socket of A gets nothing of B's.
    await expect(socketConnectToken('token-a')).resolves.toBe('token-a');
  });
});

describe('the session guard with a browser access token', () => {
  const requestSessionCheck = vi.fn();

  function guardSending(statuses: number[]) {
    const sent: { authorization: string | null; body: string | null }[] = [];
    const send: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : null;
      sent.push({ authorization: headers.get('authorization'), body });
      return new Response('{}', { status: statuses[sent.length - 1] ?? 200 });
    };
    const guard = createSessionGuard({
      reloadPage: vi.fn(),
      requestSessionCheck,
      send,
      unauthorizedDelayMs: 0,
      pageOrigin: () => 'https://www.boardsesh.com',
    });
    guard.setAccessTokenRefresher(refreshAfterRefusal, isBrowserAccessToken);
    return { guard, sent };
  }

  beforeEach(() => requestSessionCheck.mockClear());

  it('sends a refused request once more with one new token, body included', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    issuingRefresher();
    const { guard, sent } = guardSending([401, 200]);
    const request = new Request('https://backend.boardsesh.com/graphql', {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      body: '{"query":"{ authenticatedUserId }"}',
    });
    const response = await guard.fetch(request);
    expect(response.status).toBe(200);
    expect(sent.map((attempt) => attempt.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(sent[1].body).toBe('{"query":"{ authenticatedUserId }"}');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('hands a second refusal to the session check and never loops', async () => {
    rememberBrowserAccessToken('token-1', viewerA, FIFTEEN_MINUTES);
    issuingRefresher();
    const { guard, sent } = guardSending([401, 401, 401]);
    const response = await guard.fetch('https://backend.boardsesh.com/graphql', {
      method: 'POST',
      headers: { authorization: 'Bearer token-1' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(2);
    await vi.waitFor(() => expect(requestSessionCheck).toHaveBeenCalledTimes(1));
  });

  it('never retries the NextAuth token of legacy mode', async () => {
    issuingRefresher();
    const { guard, sent } = guardSending([401]);
    const response = await guard.fetch('https://backend.boardsesh.com/graphql', {
      headers: { authorization: 'Bearer nextauth-jwe' },
    });
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(1);
  });
});
