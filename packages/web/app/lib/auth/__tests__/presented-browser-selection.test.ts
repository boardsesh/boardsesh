// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import type { BrowserBindingReply } from '@boardsesh/auth-protocol/browser-binding-v1';
vi.mock('server-only', () => ({}));
import { BROWSER_CORRELATION_COOKIE, buildBrowserProofCookieCandidate } from '../browser-proof-cookies.server';
import type { BrowserBindingCommandClient } from '../browser-binding-command-client.server';
import { browserActorContextKey, readPresentedBrowserSelection } from '../presented-browser-selection.server';

const bindingToken = Buffer.alloc(32, 7).toString('base64url');
const bindingId = createHash('sha256').update(bindingToken).digest('hex');
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const cursor = () => ({ bindingId, version: 2, bindingExpiresAt: future() });
const metadata = { browserBindingProtocolVersion: 1 as const, requestId: 'e363934b-b7ba-41ba-a279-52185daa100e' };
const environment = { CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging' };
const pointer = `${BROWSER_CORRELATION_COOKIE}=${bindingToken}`;
type Admitted = Extract<BrowserBindingReply, { operation: 'read'; outcome: 'admitted' }>;
type Described = Extract<BrowserBindingReply, { operation: 'describe'; outcome: 'known' }>;
function admitted(): Admitted {
  return {
    ...metadata,
    operation: 'read',
    outcome: 'admitted',
    cursor: cursor(),
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: future(),
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.test', name: 'Owned climber', image: null },
  };
}
function described(): Described {
  return {
    ...metadata,
    operation: 'describe',
    outcome: 'known',
    state: 'selected',
    credentialKind: 'legacy-jwe',
    cursor: cursor(),
  };
}
function fixture() {
  const describe = vi.fn<BrowserBindingCommandClient['describe']>().mockResolvedValue(described());
  const read = vi.fn<BrowserBindingCommandClient['read']>().mockResolvedValue(admitted());
  const client: BrowserBindingCommandClient = {
    describe,
    read,
    bootstrap: vi.fn(),
    intent: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };
  return { describe, read, client, options: { client, environment } };
}
function proofHeader(
  kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe',
  rawCredential = 'owned-client-proof',
  version = 2,
  selectedBindingId = bindingId,
) {
  return buildBrowserProofCookieCandidate({
    cursor: { bindingId: selectedBindingId, version },
    proof: { kind, rawCredential },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: null,
  })
    .proofHeaders.map((header) => header.split(';', 1)[0])
    .join('; ');
}

describe('central server-only presented browser selection', () => {
  it.each([undefined, '', 'legacy', 'invalid'])(
    'refuses an unavailable or disabled mode before reading credentials: %s',
    async (mode) => {
      const current = fixture();
      expect(
        await readPresentedBrowserSelection(pointer, {
          client: current.client,
          environment: { CURRENT_STORE_BROWSER_BINDING_MODE: mode },
        }),
      ).toEqual({ status: 'unavailable' });
      expect(current.describe).not.toHaveBeenCalled();
    },
  );
  it('requires correlation and never authenticates a standalone legacy cookie', async () => {
    const current = fixture();
    expect(await readPresentedBrowserSelection('next-auth.session-token=old-login', current.options)).toEqual({
      status: 'missing-binding',
    });
    expect(current.describe).not.toHaveBeenCalled();
    expect(current.read).not.toHaveBeenCalled();
  });
  it.each([
    `${pointer}; ${pointer}`,
    `${BROWSER_CORRELATION_COOKIE}=invalid`,
    `${pointer}; ${BROWSER_CORRELATION_COOKIE}.extra=ambiguous`,
  ])('refuses ambiguous correlation without a backend lookup', async (header) => {
    const current = fixture();
    expect(await readPresentedBrowserSelection(header, current.options)).toEqual({ status: 'denied' });
    expect(current.describe).not.toHaveBeenCalled();
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'passes only actual %s bytes from the exact primary version',
    async (kind) => {
      const current = fixture();
      current.describe.mockResolvedValue({ ...described(), credentialKind: kind });
      const rawCredential =
        kind === 'legacy-jwe'
          ? await encode({
              secret: 'owned-presented-browser-secret',
              maxAge: 3600,
              token: {
                sub: 'owned-user',
                authSessionId: 'owned-session',
                gen: 3,
                auth_time: Date.parse('2020-01-01T00:00:00.000Z') / 1000,
                link_guarded: true,
                legacy_no_sid: true,
              },
            })
          : 'owned-actual-canonical-bearer';
      const header = [
        pointer,
        proofHeader(kind, 'older-source', 1),
        proofHeader(kind, 'future-source', 99),
        proofHeader(kind, 'foreign-source', 2, 'f'.repeat(64)),
        proofHeader(kind, rawCredential),
        'next-auth.session-token=other-account-old-mutable-cookie',
      ].join('; ');
      const result = await readPresentedBrowserSelection(header, current.options);
      const credential = kind === 'legacy-jwe' ? { kind, credential: rawCredential } : { kind, token: rawCredential };
      expect(current.read).toHaveBeenCalledExactlyOnceWith({ bindingToken, actor: { version: 2, credential } });
      expect(result).toMatchObject({
        status: 'admitted',
        bindingToken,
        actor: { version: 2, credential },
        session: {
          userId: 'owned-user',
          authSessionId: 'owned-session',
          generation: 3,
          authenticatedAt: '2020-01-01T00:00:00.000Z',
          requiresAccountCutoff: true,
        },
      });
      if (result.status !== 'admitted') throw new Error('Owned selection refused');
      for (const part of [result, result.actor, result.actor.credential, result.cursor, result.session, result.user])
        expect(Object.isFrozen(part)).toBe(true);
      expect(Reflect.set(result.session, 'generation', 9)).toBe(false);
    },
  );
  it('does not turn a known correlation pointer or older/future proofs into authentication', async () => {
    const current = fixture();
    expect(
      await readPresentedBrowserSelection(
        [
          pointer,
          proofHeader('legacy-jwe', 'older', 1),
          proofHeader('legacy-jwe', 'future', 3),
          'next-auth.session-token=valid-old-login',
        ].join('; '),
        current.options,
      ),
    ).toEqual({ status: 'proof-required' });
    expect(current.read).not.toHaveBeenCalled();
  });
  it('refuses a source kind inconsistent with the authoritative selection', async () => {
    const current = fixture();
    current.describe.mockResolvedValue({ ...described(), credentialKind: 'canonical-token' });
    expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
      status: 'denied',
    });
    expect(current.read).not.toHaveBeenCalled();
  });
  it('refuses ambiguous current proof chunks rather than falling back to a valid legacy cookie', async () => {
    const current = fixture();
    const proof = proofHeader();
    const separator = proof.indexOf('=');
    const ambiguous = `${proof}; ${proof.slice(0, separator)}.0=${proof.slice(separator + 1)}`;
    expect(
      await readPresentedBrowserSelection(`${pointer}; ${ambiguous}; next-auth.session-token=old`, current.options),
    ).toEqual({ status: 'denied' });
    expect(current.read).not.toHaveBeenCalled();
  });
  it('accepts anonymity only after matching independent primary observations', async () => {
    const current = fixture();
    current.describe.mockResolvedValue({ ...described(), state: 'anonymous', credentialKind: null });
    current.read.mockResolvedValue({ ...metadata, operation: 'read', outcome: 'anonymous', cursor: cursor() });
    expect(
      await readPresentedBrowserSelection(`${pointer}; next-auth.session-token=old`, current.options),
    ).toMatchObject({ status: 'anonymous', cursor: { bindingId, version: 2 } });
    expect(current.read).toHaveBeenCalledExactlyOnceWith({ bindingToken });
  });
  it.each(['anonymous-to-selected', 'selected-to-anonymous', 'selected-to-new-version'] as const)(
    'does not expose identity from a %s race',
    async (race) => {
      const current = fixture();
      if (race === 'anonymous-to-selected') {
        current.describe.mockResolvedValue({ ...described(), state: 'anonymous', credentialKind: null });
        current.read.mockResolvedValue({ ...admitted(), cursor: { ...cursor(), version: 3 } });
      } else if (race === 'selected-to-anonymous')
        current.read.mockResolvedValue({
          ...metadata,
          operation: 'read',
          outcome: 'anonymous',
          cursor: { ...cursor(), version: 3 },
        });
      else current.read.mockResolvedValue({ ...admitted(), cursor: { ...cursor(), version: 3 } });
      expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
        status: 'conflict',
      });
    },
  );
  it.each(['denied', 'conflict', 'unavailable'] as const)(
    'retains primary %s without inventing a session or logout',
    async (outcome) => {
      const current = fixture();
      current.read.mockResolvedValue({ ...metadata, operation: 'read', outcome });
      expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
        status: outcome,
      });
    },
  );
  it('does not acknowledge a descriptor for another binding', async () => {
    const current = fixture();
    current.describe.mockResolvedValue({ ...described(), cursor: { ...cursor(), bindingId: 'f'.repeat(64) } });
    expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
      status: 'unavailable',
    });
    expect(current.read).not.toHaveBeenCalled();
  });
  it.each(['source', 'binding'] as const)(
    'honors the original %s deadline even when the private reply arrives late',
    async (deadline) => {
      const current = fixture();
      const result = admitted();
      const expired = new Date(Date.now() - 1000).toISOString();
      if (deadline === 'source') result.session.expiresAt = expired;
      else result.cursor.bindingExpiresAt = expired;
      current.read.mockResolvedValue(result);
      expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
        status: 'denied',
      });
    },
  );
  it('keeps private transport causes and source material out of failures', async () => {
    const current = fixture();
    current.read.mockRejectedValue(new Error('owned-private-source-and-sql-cause'));
    expect(await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options)).toEqual({
      status: 'unavailable',
    });
  });
  it('derives cancellation metadata from exact admitted identity and selection, without source bytes', async () => {
    const current = fixture();
    const result = await readPresentedBrowserSelection(`${pointer}; ${proofHeader()}`, current.options);
    if (result.status !== 'admitted') throw new Error('Owned selection refused');
    const key = browserActorContextKey(result);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    for (const replacement of [
      { ...result, cursor: { ...result.cursor, version: 3 } },
      { ...result, cursor: { ...result.cursor, bindingId: 'f'.repeat(64) } },
      { ...result, session: { ...result.session, userId: 'other-user' } },
      { ...result, session: { ...result.session, authSessionId: 'later-login' } },
      { ...result, session: { ...result.session, generation: 4 } },
    ])
      expect(browserActorContextKey(replacement)).not.toBe(key);
  });
});
