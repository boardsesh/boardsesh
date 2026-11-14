// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';

const control = vi.hoisted(() => ({ observe: vi.fn(), legacyAdmission: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../browser-consumers.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-consumers.server')>();
  return { ...actual, browserConsumerFacade: { ...actual.browserConsumerFacade, observe: control.observe } };
});
vi.mock('../credential-admission.server', () => ({
  CredentialAuthorityUnavailable: class extends Error {},
  admitPresentedWebCredential: control.legacyAdmission,
}));
import { withAuthResponseAdmission } from '../auth-response-admission.server';

function selected(kind: 'canonical-token' | 'legacy-jwe' = 'canonical-token'): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: {
      version: 3,
      credential:
        kind === 'canonical-token' ? { kind, token: 'owned-opaque-source' } : { kind, credential: 'owned-actual-jwe' },
    },
    cursor: { bindingId: 'b'.repeat(64), version: 3, bindingExpiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    session: {
      userId: 'current-owner',
      authSessionId: 'current-session',
      generation: 2,
      authenticatedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    user: { id: 'current-owner', email: 'current@example.test', name: 'Current climber', image: null },
  };
}
const request = () =>
  new NextRequest('https://www.selected-admission.example.test/api/auth/callback/google', {
    headers: {
      cookie:
        '__Host-boardsesh.browser-binding=' + 'A'.repeat(43) + '; __Secure-next-auth.session-token=foreign-old-login',
    },
  });
const context = (action = 'callback') => ({ params: Promise.resolve({ nextauth: [action, 'google'] }) });
beforeEach(() => {
  control.observe.mockReset().mockImplementation(async () => selected());
  control.legacyAdmission.mockReset().mockImplementation(() => {
    throw new Error('Legacy admission must not run');
  });
});
describe('exclusive actual selected-source response admission', () => {
  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'ACKs the exact %s response only after both central source reads',
    async (kind) => {
      control.observe.mockImplementation(async () => selected(kind));
      const response = new Response(null, {
        status: 302,
        headers: { Location: '/settings', 'Set-Cookie': 'owned-flow-state=; Max-Age=0' },
      });
      const acknowledgment = vi.fn((completed) => {
        expect(control.observe).toHaveBeenCalledTimes(2);
        expect(completed).toBe(response);
      });
      expect(await withAuthResponseAdmission(request(), context(), async () => response, acknowledgment)).toBe(
        response,
      );
      expect(acknowledgment).toHaveBeenCalledTimes(1);
      expect(control.legacyAdmission).not.toHaveBeenCalled();
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    },
  );
  it('renders the canonical profile directly instead of an unrelated old NextAuth session', async () => {
    const legacySession = vi.fn(async () => Response.json({ user: { id: 'foreign-old-owner' } }));
    const acknowledgment = vi.fn();
    const response = await withAuthResponseAdmission(request(), context('session'), legacySession, acknowledgment);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: 'current-owner' },
      authSessionId: 'current-session',
      authGeneration: 2,
    });
    expect(legacySession).not.toHaveBeenCalled();
    expect(control.legacyAdmission).not.toHaveBeenCalled();
    expect(acknowledgment).toHaveBeenCalledWith(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it.each(['missing-binding', 'proof-required', 'denied', 'conflict', 'unavailable'] as const)(
    'refuses %s before invoking a legacy delegate or creating an ACK',
    async (status) => {
      control.observe.mockResolvedValue({ status });
      const invoke = vi.fn(async () => new Response(null));
      const acknowledgment = vi.fn();
      const response = await withAuthResponseAdmission(request(), context(), invoke, acknowledgment);
      expect(response.status).toBe(status === 'unavailable' ? 503 : status === 'conflict' ? 409 : 401);
      expect(invoke).not.toHaveBeenCalled();
      expect(acknowledgment).not.toHaveBeenCalled();
      expect(control.legacyAdmission).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each(['UID', 'SID', 'generation', 'version', 'binding', 'kind'] as const)(
    'withholds the entire A response after current %s changes',
    async (change) => {
      const before = selected();
      const after: AdmittedBrowserSelection = {
        ...selected(),
        session: { ...before.session },
        cursor: { ...before.cursor },
        actor: { ...before.actor },
      };
      const changed = {
        ...after,
        session: { ...after.session },
        cursor: { ...after.cursor },
        actor: { ...after.actor },
      };
      if (change === 'UID') changed.session.userId = 'new-owner';
      if (change === 'SID') changed.session.authSessionId = 'same-user-new-session';
      if (change === 'generation') changed.session.generation += 1;
      if (change === 'version') changed.cursor.version += 1;
      if (change === 'binding') changed.cursor.bindingId = 'c'.repeat(64);
      if (change === 'kind') changed.actor.credential = { kind: 'legacy-jwe', credential: 'changed-source-kind' };
      control.observe.mockResolvedValueOnce(before).mockResolvedValueOnce(changed);
      const acknowledgment = vi.fn();
      const response = await withAuthResponseAdmission(
        request(),
        context(),
        async () => Response.json({ privateA: 'must-not-publish' }),
        acknowledgment,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'conflict' });
      expect(acknowledgment).not.toHaveBeenCalled();
    },
  );
  it.each([
    '__Secure-next-auth.session-token=unqualified',
    'next-auth.session-token.0=unqualified',
    '__Secure-next-auth.session-token.future-suffix=unqualified',
    '__Host-boardsesh.browser-binding=; Max-Age=0',
    '__Host-boardsesh.browser-proof.' + 'b'.repeat(64) + '.3=unqualified',
    '__Host-boardsesh.browser-proof.' + 'b'.repeat(64) + '.2=; Max-Age=0',
  ])('refuses every unqualified auth-cookie write or clear: %s', async (header) => {
    const acknowledgment = vi.fn();
    const response = await withAuthResponseAdmission(
      request(),
      context(),
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/settings', 'Set-Cookie': header },
        }),
      acknowledgment,
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(acknowledgment).not.toHaveBeenCalled();
  });
  it('preserves primary uncertainty after the inner delegate without acknowledging its response', async () => {
    control.observe.mockResolvedValueOnce(selected()).mockResolvedValueOnce({ status: 'unavailable' });
    const acknowledgment = vi.fn();
    const response = await withAuthResponseAdmission(
      request(),
      context(),
      async () => Response.json({ privateA: 'must-not-publish' }),
      acknowledgment,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(acknowledgment).not.toHaveBeenCalled();
  });
  it('never uses an HTTP marker or the legacy sign-out callback as selected authorization', async () => {
    const acknowledgment = vi.fn();
    const response = await withAuthResponseAdmission(
      request(),
      context(),
      async (legacySignOut) => {
        const candidate = new Response(null, { headers: { 'x-provider-security-admitted': 'true' } });
        legacySignOut(candidate, 'owned-opaque-source');
        return candidate;
      },
      acknowledgment,
    );
    expect(response.status).toBe(503);
    expect(acknowledgment).not.toHaveBeenCalled();
    expect(
      (await withAuthResponseAdmission(request(), context('signout'), async () => new Response(null))).status,
    ).toBe(503);
  });
  it('does not turn an anonymous observation into an authenticated actor ACK', async () => {
    const anonymous: PresentedBrowserSelection = { status: 'anonymous', cursor: selected().cursor };
    control.observe.mockResolvedValue(anonymous);
    const acknowledgment = vi.fn();
    const response = await withAuthResponseAdmission(
      request(),
      context('session'),
      async () => Response.json({ user: { id: 'legacy-owner' } }),
      acknowledgment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(acknowledgment).not.toHaveBeenCalled();
    const invoke = vi.fn(async () => new Response(null));
    expect((await withAuthResponseAdmission(request(), context(), invoke, acknowledgment)).status).toBe(503);
    expect(invoke).not.toHaveBeenCalled();
  });
});
