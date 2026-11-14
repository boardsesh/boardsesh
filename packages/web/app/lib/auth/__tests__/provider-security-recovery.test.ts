// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
vi.mock('server-only', () => ({}));
import { BROWSER_CORRELATION_COOKIE, buildBrowserProofCookieCandidate } from '../browser-proof-cookies.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';
import { providerCandidateCredentialHash } from '../provider-security-command-client.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../provider-security-flow.server';
import { readProviderSecurityRecoveryInput } from '../provider-security-recovery.server';
import { providerBindingHash, ProviderSecurityIdentityChangedError } from '../provider-security-selection.server';

const now = new Date('2026-11-13T12:00:00.000Z');
const secret = 'owned-next-request-recovery-cookie-key-6975';
const bindingToken = 'A'.repeat(43);
const bindingId = providerBindingHash(bindingToken);
const operationKey = providerSecurityOperationKey('B'.repeat(43));
type Kind = 'legacy-jwe' | 'canonical-token';
function selected(kind: Kind = 'canonical-token'): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken,
    actor: {
      version: 3,
      credential:
        kind === 'canonical-token'
          ? { kind, token: 'exact-current-candidate' }
          : { kind, credential: 'exact-current-candidate' },
    },
    cursor: { bindingId, version: 3, bindingExpiresAt: '2026-11-14T12:00:00.000Z' },
    session: {
      userId: 'original-user',
      authSessionId: 'original-session',
      generation: 4,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-11-13T13:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'original-user', email: 'owned@example.invalid', name: null, image: null },
  };
}
function frame(kind: Kind = 'canonical-token'): ProviderSecurityFlow {
  return {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: kind,
    actorCredentialHash: providerCandidateCredentialHash({ kind, credential: 'exact-original-actor' }),
    browserBindingHash: bindingId,
    browserVersion: 2,
    browserBindingExpiresAt: selected().cursor.bindingExpiresAt,
    sourceCredentialProof: {
      version: 1,
      userId: 'original-user',
      authSessionId: 'original-session',
      generation: 3,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    credentialExpiresAt: selected().session.expiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'D'.repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: '2026-11-13T12:15:00.000Z',
    reauthenticationToken: 'E'.repeat(43),
    reauthenticationExpiresAt: '2026-11-13T12:05:00.000Z',
    providerFlowHash: 'f'.repeat(64),
    googleFlowHash: null,
    googleNonce: null,
  };
}
const pair = (header: string) => header.split(';', 1)[0];
async function observed(
  options: {
    kind?: Kind;
    old?: string | null;
    candidate?: string | null;
    carrier?: boolean;
    flow?: ProviderSecurityFlow;
  } = {},
) {
  const kind = options.kind ?? 'canonical-token';
  const flow = options.flow ?? frame(kind);
  const headers = [`${BROWSER_CORRELATION_COOKIE}=${bindingToken}`];
  if (options.old !== null)
    headers.push(
      ...buildBrowserProofCookieCandidate({
        cursor: { bindingId, version: 2 },
        proof: { kind, rawCredential: options.old ?? 'exact-original-actor' },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: null,
      }).proofHeaders.map(pair),
    );
  if (options.carrier !== false)
    headers.push(
      `${providerSecurityFlowCookieName(operationKey, true)}=${await sealProviderSecurityFlow(flow, secret, now)}`,
    );
  if (options.candidate !== null)
    headers.push(
      ...buildBrowserProofCookieCandidate({
        cursor: { bindingId, version: 3 },
        proof: { kind, rawCredential: options.candidate ?? 'exact-current-candidate' },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: headers.join('; '),
        retainObservedProofCookies: true,
      }).proofHeaders.map(pair),
    );
  return headers.join('; ');
}
const readSelection = vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>();
const read = (cookies: string | null, selector = operationKey) =>
  readProviderSecurityRecoveryInput(cookies, selector, { secret, readSelection, clock: () => new Date(now) });
beforeEach(() => {
  readSelection.mockReset().mockImplementation(async () => structuredClone(selected()));
});

describe('next-request provider result ACK possession', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'uses BOTH actual observed %s source versions; sealed metadata never reconstructs either bearer',
    async (kind) => {
      readSelection.mockResolvedValue(selected(kind));
      const cookies = await observed({ kind });
      const input = await read(cookies);
      expect(input).toEqual({
        actor: {
          kind,
          credential: 'exact-original-actor',
          expectedUserId: 'original-user',
          expectedAuthSessionId: 'original-session',
          browserBindingToken: bindingToken,
          browserVersion: 2,
        },
        intentToken: 'B'.repeat(43),
        browserIntentToken: 'C'.repeat(43),
        recoveryToken: 'D'.repeat(43),
        reauthenticationToken: 'E'.repeat(43),
        candidate: { kind, credential: 'exact-current-candidate' },
      });
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.actor)).toBe(true);
      expect(Object.isFrozen(input.candidate)).toBe(true);
      expect(readSelection).toHaveBeenCalledExactlyOnceWith(cookies);
    },
  );
  it.each(['old', 'candidate', 'carrier'] as const)(
    'refuses when the next request lacks %s possession',
    async (missing) => {
      const cookies = await observed({
        ...(missing === 'old' ? { old: null } : {}),
        ...(missing === 'candidate' ? { candidate: null } : {}),
        ...(missing === 'carrier' ? { carrier: false } : {}),
      });
      await expect(read(cookies)).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    },
  );
  it('never accepts a described primary candidate that is absent from the actual header after full reply loss', async () => {
    const cookies = await observed({ candidate: null });
    expect((await readSelection(cookies)).status).toBe('admitted');
    await expect(read(cookies)).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
  });
  it.each([{ old: 'another-original-token' }, { candidate: 'another-candidate' }])(
    'rejects changed exact observed source bytes %j',
    async (changes) => {
      await expect(read(await observed(changes))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    },
  );
  it('requires an actual distinct candidate rather than reusing the old source string', async () => {
    const current = selected();
    readSelection.mockResolvedValue({
      ...current,
      actor: { ...current.actor, credential: { kind: 'canonical-token', token: 'exact-original-actor' } },
    });
    await expect(read(await observed({ candidate: 'exact-original-actor' }))).rejects.toBeInstanceOf(
      ProviderSecurityIdentityChangedError,
    );
  });
  it.each([
    [
      'UID',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        user: { ...current.user, id: 'other-user' },
        session: { ...current.session, userId: 'other-user' },
      }),
    ],
    [
      'SID',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        session: { ...current.session, authSessionId: 'another-session' },
      }),
    ],
    [
      'generation',
      (current: AdmittedBrowserSelection) => ({ ...current, session: { ...current.session, generation: 5 } }),
    ],
    [
      'version',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        actor: { ...current.actor, version: 4 },
        cursor: { ...current.cursor, version: 4 },
      }),
    ],
    [
      'age',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        session: { ...current.session, authenticatedAt: '2026-10-01T00:00:00.000Z' },
      }),
    ],
    [
      'expiry',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        session: { ...current.session, expiresAt: '2026-11-13T14:00:00.000Z' },
      }),
    ],
    [
      'cutoff',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        session: { ...current.session, requiresAccountCutoff: false },
      }),
    ],
    [
      'guard',
      (current: AdmittedBrowserSelection) => ({ ...current, session: { ...current.session, linkGuarded: false } }),
    ],
    [
      'binding expiry',
      (current: AdmittedBrowserSelection) => ({
        ...current,
        cursor: { ...current.cursor, bindingExpiresAt: '2026-11-14T14:00:00.000Z' },
      }),
    ],
  ] as const)('denies drifted primary %s without ACK material', async (_name, change) => {
    readSelection.mockResolvedValue(change(selected()));
    await expect(read(await observed())).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
  });
  it.each(['denied', 'conflict', 'proof-required', 'missing-binding'] as const)(
    'does not use old cookies after central %s',
    async (status) => {
      readSelection.mockResolvedValue({ status });
      await expect(read(await observed())).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    },
  );
  it('preserves unavailable as unavailable rather than deriving identity from sealed flow metadata', async () => {
    readSelection.mockResolvedValue({ status: 'unavailable' });
    await expect(read(await observed())).rejects.toMatchObject({ message: AUTH_BACKEND_UNAVAILABLE });
  });
  it('refuses duplicate operation carriers before querying the primary', async () => {
    const cookies = await observed();
    const carrier = cookies
      .split('; ')
      .find((cookie) => cookie.startsWith(providerSecurityFlowCookieName(operationKey, true)))!;
    await expect(read(`${cookies}; ${carrier}`)).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it('does not let another public selector choose this operation carrier', async () => {
    await expect(read(await observed(), 'f'.repeat(64))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it('refuses a flow without an actual reauthentication capability', async () => {
    const flow = { ...frame(), reauthenticationToken: null, reauthenticationExpiresAt: null };
    await expect(read(await observed({ flow }))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
  });
  it('preserves unknown original age without treating current observation or result ACK as freshness', async () => {
    const current = selected();
    readSelection.mockResolvedValue({
      ...current,
      session: { ...current.session, authenticatedAt: null, linkGuarded: false },
    });
    const flow = {
      ...frame(),
      sourceCredentialProof: { ...frame().sourceCredentialProof, authenticatedAt: null, linkGuarded: false },
    };
    expect((await read(await observed({ flow }))).actor.expectedUserId).toBe('original-user');
  });
  it('retains deadline enforcement when primary reading takes past the proof window', async () => {
    let clock = new Date(now);
    readSelection.mockImplementationOnce(async () => {
      clock = new Date(now.getTime() + 5 * 60_000 + 1);
      return selected();
    });
    await expect(
      readProviderSecurityRecoveryInput(await observed(), operationKey, { secret, readSelection, clock: () => clock }),
    ).rejects.toMatchObject({ message: AUTH_BACKEND_UNAVAILABLE });
  });
});
