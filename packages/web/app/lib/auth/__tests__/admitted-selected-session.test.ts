// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';
import type { BrowserBackendLeaseReply } from '@boardsesh/auth-protocol/browser-backend-lease';
const control = vi.hoisted(() => ({
  observe: vi.fn(),
  lease: vi.fn(),
  legacySession: vi.fn(),
  legacyAdmission: vi.fn(),
  renderMemo: new Map<unknown, unknown>(),
}));
vi.mock('server-only', () => ({}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache:
    <Result>(compute: () => Result) =>
    () => {
      if (!control.renderMemo.has(compute)) control.renderMemo.set(compute, compute());
      return control.renderMemo.get(compute) as Result;
    },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [
      { name: '__Host-boardsesh.browser-binding', value: 'A'.repeat(43) },
      { name: '__Secure-next-auth.session-token', value: 'foreign-old-owner-cookie' },
    ],
  }),
}));
vi.mock('next-auth/next', () => ({ getServerSession: control.legacySession }));
vi.mock('../credential-admission.server', () => ({
  CredentialAuthorityUnavailable: class extends Error {},
  admitPresentedWebCredential: control.legacyAdmission,
}));
vi.mock('../browser-consumers.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-consumers.server')>();
  return {
    ...actual,
    browserConsumerFacade: { ...actual.browserConsumerFacade, observe: control.observe, lease: control.lease },
  };
});
import { getAdmittedRawServerToken, getAdmittedServerSession } from '../admitted-session.server';
import { CredentialAuthorityUnavailable } from '../credential-admission.server';
function selected(): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: { version: 2, credential: { kind: 'canonical-token', token: 'actual-opaque-never-forwarded' } },
    cursor: { bindingId: 'b'.repeat(64), version: 2, bindingExpiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    session: {
      userId: 'current-owner',
      authSessionId: 'current-session',
      generation: 3,
      authenticatedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    user: { id: 'current-owner', email: 'current@example.test', name: 'Current climber', image: null },
  };
}
beforeEach(() => {
  control.renderMemo.clear();
  control.observe.mockReset().mockImplementation(async (): Promise<PresentedBrowserSelection> => selected());
  control.lease
    .mockReset()
    .mockImplementation(async (source: AdmittedBrowserSelection): Promise<BrowserBackendLeaseReply> => ({
      status: 'admitted',
      token: 'bsbd1_BACKENDONLYLEASE',
      usableForMs: 60_000,
      owner: {
        userId: source.session.userId,
        authSessionId: source.session.authSessionId,
        generation: source.session.generation,
        cursor: { bindingId: source.cursor.bindingId, version: source.cursor.version },
      },
    }));
  control.legacySession.mockReset().mockRejectedValue(new Error('Legacy session must not run'));
  control.legacyAdmission.mockReset().mockRejectedValue(new Error('Legacy admission must not run'));
});
describe('selected-source server render admission', () => {
  it('shares actual central admission and one short lease across server forwarding callers', async () => {
    expect(await Promise.all(Array.from({ length: 15 }, () => getAdmittedRawServerToken()))).toEqual(
      Array(15).fill('bsbd1_BACKENDONLYLEASE'),
    );
    expect(control.observe).toHaveBeenCalledTimes(1);
    expect(control.lease).toHaveBeenCalledTimes(1);
    expect(control.legacyAdmission).not.toHaveBeenCalled();
    expect(control.legacySession).not.toHaveBeenCalled();
  });
  it('projects only the selected profile without legacy session renewal or bearer manufacture', async () => {
    const session = await getAdmittedServerSession();
    expect(session).toMatchObject({
      user: { id: 'current-owner' },
      authSessionId: 'current-session',
      authGeneration: 3,
      browserSelection: { cursor: { bindingId: 'b'.repeat(64), version: 2 } },
    });
    expect(JSON.stringify(session)).not.toContain('actual-opaque-never-forwarded');
    expect(control.lease).not.toHaveBeenCalled();
    expect(control.legacySession).not.toHaveBeenCalled();
    expect(control.legacyAdmission).not.toHaveBeenCalled();
  });
  it.each(['missing-binding', 'proof-required', 'denied'] as const)(
    'does not fall back to an old cookie after %s',
    async (status) => {
      control.observe.mockResolvedValue({ status });
      expect(await getAdmittedServerSession()).toBeNull();
      expect(await getAdmittedRawServerToken()).toBeUndefined();
      expect(control.lease).not.toHaveBeenCalled();
      expect(control.legacySession).not.toHaveBeenCalled();
      expect(control.legacyAdmission).not.toHaveBeenCalled();
    },
  );
  it.each(['unavailable', 'conflict'] as const)('keeps %s distinct from an anonymous viewer', async (status) => {
    control.observe.mockResolvedValue({ status });
    await expect(getAdmittedServerSession()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
    await expect(getAdmittedRawServerToken()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
    expect(control.legacySession).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'conflict'] as const)(
    'does not substitute actual source bytes when backend lease is %s',
    async (status) => {
      control.lease.mockResolvedValue({ status });
      await expect(getAdmittedRawServerToken()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
      expect(control.legacyAdmission).not.toHaveBeenCalled();
    },
  );
  it('forwards no credential after a confirmed backend lease denial', async () => {
    control.lease.mockResolvedValue({ status: 'denied' });
    expect(await getAdmittedRawServerToken()).toBeUndefined();
    expect(control.legacyAdmission).not.toHaveBeenCalled();
  });
  it('captures a new selected account on the next render instead of reusing an earlier render snapshot', async () => {
    expect((await getAdmittedServerSession())?.user.id).toBe('current-owner');
    control.renderMemo.clear();
    const next = selected();
    control.observe.mockResolvedValue({
      ...next,
      user: { ...next.user, id: 'next-owner' },
      session: { ...next.session, userId: 'next-owner', authSessionId: 'next-session' },
      cursor: { ...next.cursor, version: 3 },
    });
    expect((await getAdmittedServerSession())?.user.id).toBe('next-owner');
    expect(control.observe).toHaveBeenCalledTimes(2);
    expect(control.legacySession).not.toHaveBeenCalled();
  });
});
