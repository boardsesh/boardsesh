// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

import { webLogger } from '@/app/lib/observability/logger';
import { EXPECTED_VIEWER_HEADER, isViewerChangedBody } from '../expected-viewer';
import { admittedViewerKey, requireExpectedViewer, type MissingExpectedViewer } from '../expected-viewer.server';

const accountA = { user: { id: 'user-a' }, authSessionId: 'login-a' };
const ROUTE = '/api/internal/profile/[userId]';

function request(expected?: string): Request {
  return new Request('https://www.boardsesh.test/api/internal/profile/user-c?tab=sends', {
    headers: expected === undefined ? {} : { [EXPECTED_VIEWER_HEADER]: expected },
  });
}

async function verdict(expected: string | undefined, session: typeof accountA | null, missing: MissingExpectedViewer) {
  const response = requireExpectedViewer(request(expected), session, { route: ROUTE, missing });
  if (!response) return 'proceed';
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

const conflict = {
  status: 409,
  body: { code: 'viewer_changed', error: 'Reload this page.' },
  cache: 'private, no-store',
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('requireExpectedViewer', () => {
  it('lets a request through when it names the account the cookie resolved to, and logs nothing', async () => {
    expect(await verdict('user-a:login-a', accountA, 'reject')).toBe('proceed');
    expect(await verdict('user-a:login-a', accountA, 'allow')).toBe('proceed');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['another account', 'user-b:login-b'],
    ['another login of the same account', 'user-a:login-a2'],
    ['a signed-out tab', 'anonymous'],
  ])('answers 409 with only the fixed code and plain text for %s', async (_label, expected) => {
    expect(await verdict(expected, accountA, 'reject')).toEqual(conflict);
    expect(await verdict(expected, accountA, 'allow')).toEqual(conflict);
  });

  it('answers 409 when a signed-in tab sends a request the cookie answers as signed out', async () => {
    expect(await verdict('user-a:login-a', null, 'allow')).toEqual(conflict);
  });

  it('lets a signed-out tab through when the cookie is signed out too', async () => {
    expect(await verdict('anonymous', null, 'reject')).toBe('proceed');
  });

  it.each(['', 'user-a', 'user-a:', ':login-a', 'USER-A:LOGIN-A', 'user-a:login-a:extra', 'null', 'user a:login-a'])(
    'treats the value %j as a mismatch',
    async (expected) => {
      expect(await verdict(expected, accountA, 'allow')).toEqual(conflict);
    },
  );

  it('refuses a missing header from a signed-in cookie only where the route requires it', async () => {
    expect(await verdict(undefined, accountA, 'reject')).toEqual(conflict);
    expect(await verdict(undefined, accountA, 'allow')).toBe('proceed');
  });

  it('lets a request with neither header nor signed-in cookie reach the route, which answers it as signed out', async () => {
    expect(await verdict(undefined, null, 'reject')).toBe('proceed');
    expect(await verdict(undefined, null, 'allow')).toBe('proceed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keys a session without an auth session id the way the browser guard does', async () => {
    const pending = { user: { id: 'user-a' } };
    expect(admittedViewerKey(pending)).toBe('user-a:pending-login-identity');
    expect(
      requireExpectedViewer(request('user-a:pending-login-identity'), pending, { route: ROUTE, missing: 'reject' }),
    ).toBeNull();
  });

  it('reads a session without a user id as signed out', () => {
    expect(admittedViewerKey({ user: null })).toBe('anonymous');
    expect(admittedViewerKey(null)).toBe('anonymous');
  });
});

describe('the refusal log line', () => {
  it.each([
    ['header_missing', undefined, accountA, 'reject'],
    ['other_user', 'user-b:login-b', accountA, 'allow'],
    ['other_user', 'anonymous', accountA, 'allow'],
    ['other_session', 'user-a:login-a2', accountA, 'allow'],
    ['anonymous_cookie', 'user-a:login-a', null, 'allow'],
    ['malformed', 'user-a', accountA, 'allow'],
    ['malformed', ':login-a', null, 'allow'],
    ['malformed', 'user a:login-a', accountA, 'allow'],
  ] as const)('logs %s for %j', async (reason, expected, session, missing) => {
    await verdict(expected, session, missing);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('expected viewer refused', {
      route: ROUTE,
      method: 'GET',
      status: 409,
      reason,
    });
  });

  it('never writes an id, the header value or the resolved path', async () => {
    await verdict('user-b:login-b', accountA, 'allow');

    const written = JSON.stringify(warn.mock.calls);
    for (const secret of ['user-a', 'login-a', 'user-b', 'login-b', 'user-c', 'tab=sends'])
      expect(written).not.toContain(secret);
  });
});

describe('isViewerChangedBody', () => {
  const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('recognises only the fixed code', () => {
    expect(isViewerChangedBody(encode('{"code":"viewer_changed","error":"Reload this page."}'))).toBe(true);
    expect(isViewerChangedBody(encode('{"code":"viewer_changed"}'))).toBe(true);
    expect(isViewerChangedBody(encode('{"error":"Password already set."}'))).toBe(false);
    expect(isViewerChangedBody(encode('{"error":"identity_changed"}'))).toBe(false);
    expect(isViewerChangedBody(encode('not json'))).toBe(false);
    expect(isViewerChangedBody(encode(''))).toBe(false);
    expect(isViewerChangedBody(encode(`{"code":"viewer_changed","pad":"${'x'.repeat(300)}"}`))).toBe(false);
  });
});
