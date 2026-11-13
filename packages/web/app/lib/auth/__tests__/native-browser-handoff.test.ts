// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import type { AdmittedBrowserSelection } from '../presented-browser-selection.server';
vi.mock('server-only', () => ({}));
import { createSelectedNativeBrowserHandoff } from '../native-browser-handoff.server';
import { issueNativeBrowserHandoffToken } from '../native-browser-handoff-token.server';
import { nativeBrowserHandoffCommandSchema } from '@boardsesh/auth-protocol/native-browser-handoff-v1';

function selection(): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: Buffer.alloc(32, 7).toString('base64url'),
    actor: { version: 4, credential: { kind: 'canonical-token', token: 'actual-owned-source' } },
    cursor: { bindingId: 'a'.repeat(64), version: 4, bindingExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
    session: {
      userId: 'owner',
      authSessionId: 'original-sign-in',
      generation: 3,
      authenticatedAt: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      linkGuarded: false,
      requiresAccountCutoff: false,
    },
    user: { id: 'owner', name: null, email: 'owner@example.test', image: null },
  };
}
function fixture() {
  const source = selection();
  const observe = vi.fn().mockResolvedValue(source);
  const issue = vi.fn<typeof issueNativeBrowserHandoffToken>().mockResolvedValue({
    status: 'admitted',
    token: 'bsnh1_OWNEDCAPABILITY',
    cursor: source.cursor,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usableForMs: 60_000,
    userId: source.session.userId,
    authSessionId: source.session.authSessionId,
  });
  return { source, observe, issue, run: createSelectedNativeBrowserHandoff({ observe, issue }) };
}
describe('source-owning selected native callback', () => {
  it('hands the exact source to the private issuer and re-observes primary before publishing the opaque token', async () => {
    const test = fixture();
    expect(await test.run('owned-cookie')).toEqual({ status: 'admitted', transferToken: 'bsnh1_OWNEDCAPABILITY' });
    expect(test.issue).toHaveBeenCalledExactlyOnceWith(test.source);
    expect(test.observe.mock.calls).toEqual([['owned-cookie'], ['owned-cookie']]);
  });
  it.each(['anonymous', 'missing-binding', 'proof-required', 'denied', 'conflict', 'unavailable'] as const)(
    'never falls back from selected %s',
    async (status) => {
      const test = fixture();
      test.observe.mockResolvedValue({ status });
      expect(await test.run('owned-cookie')).toEqual({
        status: status === 'conflict' || status === 'unavailable' ? status : 'denied',
      });
      expect(test.issue).not.toHaveBeenCalled();
    },
  );
  it('returns only the explicit legacy decision without issuing a capability', async () => {
    const test = fixture();
    test.observe.mockResolvedValue({ status: 'legacy' });
    expect(await test.run(null)).toEqual({ status: 'legacy' });
    expect(test.issue).not.toHaveBeenCalled();
  });
  it.each(['owner', 'source', 'cursor', 'unavailable'] as const)(
    'drops the issued token when final %s changes',
    async (change) => {
      const test = fixture();
      const current = structuredClone(test.source);
      if (change === 'owner') Object.assign(current.session, { userId: 'another-user' });
      if (change === 'source')
        Object.assign(current.actor, { credential: { kind: 'canonical-token', token: 'different-actual-source' } });
      if (change === 'cursor') Object.assign(current.cursor, { version: 5 });
      test.observe
        .mockResolvedValueOnce(test.source)
        .mockResolvedValueOnce(change === 'unavailable' ? { status: 'unavailable' } : current);
      expect(await test.run('owned-cookie')).toEqual({ status: change === 'unavailable' ? 'unavailable' : 'conflict' });
    },
  );
});

describe('fixed-purpose private native handoff RPC', () => {
  const environment = {
    NODE_ENV: 'test',
    CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:54678',
    CURRENT_STORE_AUTH_RPC_SECRET: 'owned-native-handoff-private-service-secret-6975',
    NEXTAUTH_SECRET: 'unrelated-browser-key',
  };
  function transport(transform: (reply: Record<string, unknown>) => Record<string, unknown> = (reply) => reply) {
    const source = selection();
    const send = vi.fn<typeof fetch>(async (input, settings) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).toBe(
        `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}/api/internal/auth/native-browser-handoff/v1/issue`,
      );
      expect(new Headers(settings?.headers).has('cookie')).toBe(false);
      if (typeof settings?.body !== 'string') throw new Error('Owned serialized handoff command missing');
      const command = nativeBrowserHandoffCommandSchema.parse(JSON.parse(settings.body));
      expect(command.payload).toEqual({ bindingToken: source.bindingToken, actor: source.actor });
      return Response.json(
        transform({
          nativeBrowserHandoffProtocolVersion: 1,
          operation: 'issue',
          requestId: command.requestId,
          outcome: 'admitted',
          token: 'bsnh1_OWNEDCAPABILITY',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          cursor: source.cursor,
          userId: source.session.userId,
          authSessionId: source.session.authSessionId,
        }),
      );
    });
    return { source, send, run: () => issueNativeBrowserHandoffToken(source, { environment, fetch: send }) };
  }
  it('uses the native family and exact private source; no backend bearer or public session facts sign it', async () => {
    expect(await transport().run()).toMatchObject({ status: 'admitted', token: 'bsnh1_OWNEDCAPABILITY' });
  });
  it.each([
    ['token', 'bsbd1_BACKENDBEARER'],
    ['token', `bsnh1_${'A'.repeat(3995)}`],
    ['nativeBrowserHandoffProtocolVersion', 2],
    ['operation', 'delegate'],
    ['userId', 'another-user'],
    ['sourceCredential', 'forbidden-source'],
  ])('refuses wrong %s before publishing a native capability', async (property, altered) => {
    const test = transport((reply) => ({ ...reply, [property]: altered }));
    expect(await test.run()).toEqual({ status: 'unavailable' });
    expect(test.send).toHaveBeenCalledOnce();
  });
});
