// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PresentedBrowserSelection, AdmittedBrowserSelection } from '../presented-browser-selection.server';
vi.mock('server-only', () => ({}));
import { createBrowserConsumerFacade } from '../browser-consumers.server';
import { publicBrowserConsumersReady } from '../browser-consumer-readiness';

function selection(): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: { version: 4, credential: { kind: 'canonical-token', token: 'owned-actual-source-never-public' } },
    cursor: { bindingId: 'b'.repeat(64), version: 4, bindingExpiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.test', name: 'Owned climber', image: null },
  };
}
function fixture(mode = 'backend-staging', ready = true) {
  const observed = selection();
  const readSelection = vi.fn(async (): Promise<PresentedBrowserSelection> => observed);
  const issueToken = vi.fn(async () => ({
    status: 'admitted' as const,
    token: 'bsbd1_OWNEDSHORTLEASE',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usableForMs: 60_000,
    cursor: observed.cursor,
    userId: observed.session.userId,
    authSessionId: observed.session.authSessionId,
  }));
  const facade = createBrowserConsumerFacade({
    ready: () => ready,
    environment: () => ({ CURRENT_STORE_BROWSER_BINDING_MODE: mode }),
    readSelection,
    issueToken,
  });
  const request = new NextRequest('https://www.browser-consumer.example.test/api/auth/session', {
    headers: {
      cookie:
        '__Host-boardsesh.browser-binding=' +
        'A'.repeat(43) +
        '; __Secure-next-auth.session-token=unrelated-old-legacy',
    },
  });
  return { observed, readSelection, issueToken, facade, request };
}
afterEach(() => vi.unstubAllEnvs());
describe('dark selected browser consumer facade', () => {
  it('keeps the code-owned readiness gate false regardless of flags', () => {
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'backend-staging');
    vi.stubEnv('BROWSER_PUBLIC_READERS_READY', 'true');
    expect(publicBrowserConsumersReady()).toBe(false);
  });
  it('delegates only legacy mode with no reserved correlation cookie', async () => {
    const current = fixture('legacy', false);
    expect(await current.facade.observe('unrelated=value')).toEqual({ status: 'legacy' });
    expect(await current.facade.sessionResponse(new NextRequest(current.request.url))).toBeNull();
    expect(await current.facade.tokenResponse(new NextRequest(current.request.url))).toBeNull();
    expect(current.readSelection).not.toHaveBeenCalled();
    expect(current.issueToken).not.toHaveBeenCalled();
  });
  it.each([
    '__Host-boardsesh.browser-binding=' + 'A'.repeat(43),
    '__Host-boardsesh.browser-binding=malformed',
    '__Host-boardsesh.browser-binding.suffix=unknown',
    '__Host-boardsesh.browser-binding',
    '__Host-boardsesh.browser-binding=first; __Host-boardsesh.browser-binding=second',
  ])('never falls through to legacy with reserved correlation material: %s', async (cookie) => {
    const current = fixture('legacy', false);
    expect(await current.facade.observe(cookie)).toEqual({ status: 'unavailable' });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('refuses selected mode even without a cookie while public readiness is false', async () => {
    const current = fixture('backend-staging', false);
    expect(await current.facade.observe(null)).toEqual({ status: 'unavailable' });
    const response = await current.facade.tokenResponse(current.request);
    expect(response?.status).toBe(503);
    expect(response?.headers.getSetCookie()).toEqual([]);
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('refuses invalid mode configuration without reading any legacy identity', async () => {
    const current = fixture('invalid');
    expect(await current.facade.observe(null)).toEqual({ status: 'unavailable' });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('projects the actual canonical account while an unrelated old legacy cookie remains', async () => {
    const current = fixture();
    const response = await current.facade.sessionResponse(current.request);
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    expect(body).toEqual({
      user: current.observed.user,
      expires: current.observed.session.expiresAt,
      authSessionId: 'owned-session',
      authGeneration: 3,
      browserSelection: {
        userId: 'owned-user',
        authSessionId: 'owned-session',
        generation: 3,
        cursor: { bindingId: 'b'.repeat(64), version: 4 },
      },
    });
    expect(current.readSelection).toHaveBeenCalledWith(current.request.headers.get('cookie'), {
      environment: { CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging' },
    });
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response?.headers.getSetCookie()).toEqual([]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      'owned-actual-source-never-public',
      'bindingToken',
      'bindingExpiresAt',
      'authenticatedAt',
      'requiresAccountCutoff',
    ])
      expect(serialized).not.toContain(secret);
    expect(current.issueToken).not.toHaveBeenCalled();
  });
  it('returns only the current short lease and public owner, with no profile or private envelope', async () => {
    const current = fixture();
    const { tokenResponse } = current.facade;
    const response = await tokenResponse(current.request);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      status: 'admitted',
      token: 'bsbd1_OWNEDSHORTLEASE',
      usableForMs: expect.any(Number),
      owner: {
        userId: 'owned-user',
        authSessionId: 'owned-session',
        generation: 3,
        cursor: { bindingId: 'b'.repeat(64), version: 4 },
      },
    });
    expect(response?.headers.getSetCookie()).toEqual([]);
    expect(current.issueToken).toHaveBeenCalledWith(current.observed);
  });
  it('bounds ordinary public session expiry by the binding without exposing its private cursor field', async () => {
    const current = fixture();
    const bindingExpiry = new Date(Date.now() + 10_000).toISOString();
    current.readSelection.mockResolvedValue({
      ...current.observed,
      cursor: { ...current.observed.cursor, bindingExpiresAt: bindingExpiry },
    });
    const response = await current.facade.sessionResponse(current.request);
    const body = await response?.json();
    expect(body.expires).toBe(bindingExpiry);
    expect(body.browserSelection.cursor).toEqual({ bindingId: 'b'.repeat(64), version: 4 });
  });
  it('does not restart the same-process effective lease deadline during public projection', async () => {
    const current = fixture();
    const issued = await current.issueToken();
    current.issueToken.mockResolvedValueOnce({ ...issued, expiresAt: new Date(Date.now() + 5000).toISOString() });
    const response = await current.facade.tokenResponse(current.request);
    const body = await response?.json();
    expect(response?.status).toBe(200);
    expect(body.usableForMs).toBeGreaterThan(0);
    expect(body.usableForMs).toBeLessThanOrEqual(5000);
    current.issueToken.mockResolvedValueOnce({ ...issued, expiresAt: new Date(0).toISOString() });
    expect((await current.facade.tokenResponse(current.request))?.status).toBe(503);
  });
  it.each(['missing-binding', 'proof-required', 'denied', 'conflict', 'unavailable'] as const)(
    'preserves a selected %s as a final response, never a legacy delegation',
    async (status) => {
      const current = fixture();
      current.readSelection.mockResolvedValue({ status });
      const session = await current.facade.sessionResponse(current.request);
      const lease = await current.facade.tokenResponse(current.request);
      const expectedStatus = status === 'conflict' ? 409 : status === 'unavailable' ? 503 : 401;
      expect(session?.status).toBe(expectedStatus);
      expect(lease?.status).toBe(expectedStatus);
      expect(session?.headers.getSetCookie()).toEqual([]);
      expect(lease?.headers.getSetCookie()).toEqual([]);
      expect(current.issueToken).not.toHaveBeenCalled();
    },
  );
  it('projects a confirmed anonymous selection without manufacturing a token', async () => {
    const current = fixture();
    current.readSelection.mockResolvedValue({ status: 'anonymous', cursor: current.observed.cursor });
    expect(await (await current.facade.sessionResponse(current.request))?.json()).toEqual({});
    expect((await current.facade.tokenResponse(current.request))?.status).toBe(401);
    expect(current.issueToken).not.toHaveBeenCalled();
  });
  it('sanitizes reader uncertainty and refuses an inconsistent profile projection', async () => {
    const current = fixture();
    current.readSelection.mockRejectedValueOnce(new Error('owned-source-material-never-public'));
    const failed = await current.facade.sessionResponse(current.request);
    expect(failed?.status).toBe(503);
    expect(JSON.stringify(await failed?.json())).not.toContain('owned-source-material');
    current.readSelection.mockResolvedValueOnce({
      ...current.observed,
      user: { ...current.observed.user, id: 'wrong-profile' },
    });
    expect((await current.facade.sessionResponse(current.request))?.status).toBe(503);
  });
  it.each(['UID', 'SID', 'binding', 'version', 'source-token'] as const)(
    'refuses a mismatched private lease %s before public publication',
    async (field) => {
      const current = fixture();
      const original = await current.issueToken();
      const altered = { ...original, cursor: { ...original.cursor } };
      if (field === 'UID') altered.userId = 'wrong-user';
      if (field === 'SID') altered.authSessionId = 'wrong-session';
      if (field === 'binding') altered.cursor.bindingId = 'c'.repeat(64);
      if (field === 'version') altered.cursor.version += 1;
      if (field === 'source-token') altered.token = 'raw.source.jwe.must.not.publish';
      current.issueToken.mockResolvedValue(altered);
      const response = await current.facade.tokenResponse(current.request);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ status: 'unavailable' });
    },
  );
});
