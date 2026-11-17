// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

import { EXPECTED_VIEWER_HEADER, isViewerChangedBody } from '../expected-viewer';
import { admittedViewerKey, requireExpectedViewer, type MissingExpectedViewer } from '../expected-viewer.server';

const accountA = { user: { id: 'user-a' }, authSessionId: 'login-a' };

function request(expected?: string): Request {
  return new Request('https://www.boardsesh.test/api/internal/controllers', {
    headers: expected === undefined ? {} : { [EXPECTED_VIEWER_HEADER]: expected },
  });
}

async function verdict(expected: string | undefined, session: typeof accountA | null, missing: MissingExpectedViewer) {
  const response = requireExpectedViewer(request(expected), session, missing);
  if (!response) return 'proceed';
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

const conflict = { status: 409, body: { code: 'viewer_changed' }, cache: 'private, no-store' };

describe('requireExpectedViewer', () => {
  it('lets a request through when it names the account the cookie resolved to', async () => {
    expect(await verdict('user-a:login-a', accountA, 'reject')).toBe('proceed');
    expect(await verdict('user-a:login-a', accountA, 'allow')).toBe('proceed');
  });

  it.each([
    ['another account', 'user-b:login-b'],
    ['another login of the same account', 'user-a:login-a2'],
    ['a signed-out tab', 'anonymous'],
  ])('answers 409 with only the fixed code for %s', async (_label, expected) => {
    expect(await verdict(expected, accountA, 'reject')).toEqual(conflict);
    expect(await verdict(expected, accountA, 'allow')).toEqual(conflict);
  });

  it('answers 409 when a signed-in tab sends a request the cookie answers as signed out', async () => {
    expect(await verdict('user-a:login-a', null, 'allow')).toEqual(conflict);
  });

  it('lets a signed-out tab through when the cookie is signed out too', async () => {
    expect(await verdict('anonymous', null, 'reject')).toBe('proceed');
  });

  it.each(['', 'user-a', 'user-a:', ':login-a', 'USER-A:LOGIN-A', 'user-a:login-a:extra', 'null'])(
    'treats the malformed value %j as a mismatch',
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
  });

  it('keys a session without an auth session id the way the browser guard does', async () => {
    const pending = { user: { id: 'user-a' } };
    expect(admittedViewerKey(pending)).toBe('user-a:pending-login-identity');
    expect(requireExpectedViewer(request('user-a:pending-login-identity'), pending, 'reject')).toBeNull();
  });

  it('reads a session without a user id as signed out', () => {
    expect(admittedViewerKey({ user: null })).toBe('anonymous');
    expect(admittedViewerKey(null)).toBe('anonymous');
  });
});

describe('isViewerChangedBody', () => {
  const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('recognises only the fixed code', () => {
    expect(isViewerChangedBody(encode('{"code":"viewer_changed"}'))).toBe(true);
    expect(isViewerChangedBody(encode('{"error":"Password already set."}'))).toBe(false);
    expect(isViewerChangedBody(encode('{"error":"identity_changed"}'))).toBe(false);
    expect(isViewerChangedBody(encode('not json'))).toBe(false);
    expect(isViewerChangedBody(encode(''))).toBe(false);
    expect(isViewerChangedBody(encode(`{"code":"viewer_changed","pad":"${'x'.repeat(300)}"}`))).toBe(false);
  });
});
