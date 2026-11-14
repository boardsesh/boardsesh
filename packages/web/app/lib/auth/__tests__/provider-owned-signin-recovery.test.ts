// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { BROWSER_CORRELATION_COOKIE, buildBrowserProofCookieCandidate } from '../browser-proof-cookies.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';
import {
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
  type ProviderSecurityOperationReply,
} from '../provider-security-command-client.server';
import {
  providerOwnedSigninCookieName,
  sealProviderOwnedSigninFlow,
  type ProviderOwnedSigninFlow,
} from '../provider-owned-signin-flow.server';
import {
  createProviderOwnedSigninAcknowledgment,
  readProviderOwnedSigninRecoveryInput,
} from '../provider-owned-signin-recovery.server';
import { providerBindingHash, ProviderSecurityIdentityChangedError } from '../provider-security-selection.server';

const now = Date.UTC(2026, 10, 14, 12);
const secret = 'owned-provider-next-request-recovery-secret-6975';
const bindingToken = 'A'.repeat(43);
const bindingId = providerBindingHash(bindingToken);
const flowHash = 'a'.repeat(64);
type Kind = 'legacy-jwe' | 'canonical-token';
function selected(kind: Kind = 'canonical-token'): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken,
    actor: {
      version: 3,
      credential: kind === 'canonical-token' ? { kind, token: 'actual-B' } : { kind, credential: 'actual-B' },
    },
    cursor: { bindingId, version: 3, bindingExpiresAt: new Date(now + 7_200_000).toISOString() },
    session: {
      userId: 'owner-B',
      authSessionId: 'session-B',
      generation: 4,
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: false,
      expiresAt: new Date(now + 3_600_000).toISOString(),
    },
    user: { id: 'owner-B', email: 'stored-B@example.test', name: null, image: null },
  };
}
function frame(kind: Kind = 'canonical-token'): ProviderOwnedSigninFlow {
  const current = selected(kind);
  return {
    version: 1,
    provider: 'apple',
    actorKind: kind,
    actorCredentialHash: providerCandidateCredentialHash({ kind, credential: 'actual-A' }),
    browserBindingHash: bindingId,
    browserVersion: 2,
    browserBindingExpiresAt: current.cursor.bindingExpiresAt,
    sourceCredentialProof: {
      version: 1,
      userId: 'owner-A',
      authSessionId: 'session-A',
      generation: 2,
      authenticatedAt: null,
      linkGuarded: false,
    },
    credentialExpiresAt: new Date(now + 1_800_000).toISOString(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    flowHash,
    nonce: null,
    returnUrl: 'https://www.example.test/settings',
    preparationToken: 'D'.repeat(43),
    preparation: {
      provider: 'apple',
      subject: 'owned-B-subject',
      credentialProof: {
        version: 1,
        userId: current.session.userId,
        authSessionId: current.session.authSessionId,
        generation: current.session.generation,
        authenticatedAt: current.session.authenticatedAt,
        linkGuarded: current.session.linkGuarded,
      },
      credentialExpiresAt: current.session.expiresAt,
      expiresAt: new Date(now + 120_000).toISOString(),
      proposedCanonicalTokenHash:
        kind === 'canonical-token' ? providerCandidateCredentialHash({ kind, credential: 'actual-B' }) : null,
    },
  };
}
async function observed(
  options: {
    kind?: Kind;
    old?: string | null;
    candidate?: string | null;
    carrier?: boolean;
    flow?: ProviderOwnedSigninFlow;
  } = {},
) {
  const kind = options.kind ?? 'canonical-token';
  const flow = options.flow ?? frame(kind);
  const headers = [`${BROWSER_CORRELATION_COOKIE}=${bindingToken}`];
  if (options.old !== null)
    headers.push(
      ...buildBrowserProofCookieCandidate({
        cursor: { bindingId, version: 2 },
        proof: { kind, rawCredential: options.old ?? 'actual-A' },
        proofMaxAgeSeconds: 1800,
        observedCookieHeader: null,
      }).proofHeaders.map((header) => header.split(';', 1)[0]),
    );
  if (options.carrier !== false)
    headers.push(`${providerOwnedSigninCookieName(flowHash)}=${await sealProviderOwnedSigninFlow(flow, secret)}`);
  if (options.candidate !== null)
    headers.push(
      ...buildBrowserProofCookieCandidate({
        cursor: { bindingId, version: 3 },
        proof: { kind, rawCredential: options.candidate ?? 'actual-B' },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: headers.join('; '),
        retainObservedProofCookies: true,
      }).proofHeaders.map((header) => header.split(';', 1)[0]),
    );
  return headers.join('; ');
}
const readSelection = vi.fn<(header: string | null) => Promise<PresentedBrowserSelection>>();
const read = (header: string | null, hash = flowHash) =>
  readProviderOwnedSigninRecoveryInput(header, hash, { secret, readSelection });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now });
  readSelection.mockReset().mockImplementation(async () => selected());
});
afterEach(() => vi.useRealTimers());

describe('owned-account sign-in next-request exact ACK', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'uses physically observed old A and selected %s B without reconstructing either bearer',
    async (kind) => {
      readSelection.mockResolvedValue(selected(kind));
      const receipt = await read(await observed({ kind }));
      expect(receipt.command.actor).toEqual({
        kind,
        credential: 'actual-A',
        expectedUserId: 'owner-A',
        expectedAuthSessionId: 'session-A',
        browserBindingToken: bindingToken,
        browserVersion: 2,
      });
      expect(receipt.command.candidate).toEqual({ kind, credential: 'actual-B' });
      expect(receipt.command.preparation.credentialProof.userId).toBe('owner-B');
      expect(receipt.browserCursor).toEqual(selected(kind).cursor);
      expect(Object.isFrozen(receipt.command)).toBe(true);
    },
  );
  it.each(['old', 'candidate', 'carrier'] as const)(
    'rejects missing %s even when primary describes B',
    async (missing) => {
      await expect(
        read(
          await observed({
            ...(missing === 'old' ? { old: null } : {}),
            ...(missing === 'candidate' ? { candidate: null } : {}),
            ...(missing === 'carrier' ? { carrier: false } : {}),
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    },
  );
  it.each([{ old: 'another-A' }, { candidate: 'another-B' }])('rejects different actual bytes %j', async (changes) => {
    await expect(read(await observed(changes))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
  });
  it.each(['uid', 'sid', 'generation', 'age', 'guard', 'cutoff', 'expiry', 'version', 'binding-expiry'] as const)(
    'rejects primary %s drift',
    async (field) => {
      const original = selected();
      const current = {
        ...original,
        user: { ...original.user },
        session: { ...original.session },
        actor: { ...original.actor },
        cursor: { ...original.cursor },
      };
      if (field === 'uid') {
        current.session.userId = 'other-owner';
        current.user.id = 'other-owner';
      }
      if (field === 'sid') current.session.authSessionId = 'other-session';
      if (field === 'generation') current.session.generation += 1;
      if (field === 'age') current.session.authenticatedAt = new Date(now - 1000).toISOString();
      if (field === 'guard') {
        current.session.linkGuarded = true;
        current.session.authenticatedAt = new Date(now - 1000).toISOString();
      }
      if (field === 'cutoff') current.session.requiresAccountCutoff = true;
      if (field === 'expiry') current.session.expiresAt = new Date(now + 3_601_000).toISOString();
      if (field === 'version') {
        current.actor.version += 1;
        current.cursor.version += 1;
      }
      if (field === 'binding-expiry') current.cursor.bindingExpiresAt = new Date(now + 7_201_000).toISOString();
      readSelection.mockResolvedValue(current);
      await expect(read(await observed())).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    },
  );
  it('requires a prepared carrier and exact flow selector', async () => {
    const flow = frame();
    flow.preparation = null;
    flow.preparationToken = null;
    await expect(read(await observed({ flow }))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
    await expect(read(await observed(), 'b'.repeat(64))).rejects.toBeInstanceOf(ProviderSecurityIdentityChangedError);
  });
  it('refuses an expired preparation after the primary read', async () => {
    const header = await observed();
    readSelection.mockImplementation(async () => {
      vi.setSystemTime(now + 120_000);
      return selected();
    });
    await expect(read(header)).rejects.toThrow();
  });
  it.each(['success', 'wrong-hash', 'wrong-cursor', 'committed', 'unknown', 'later-selection', 'aborted'] as const)(
    'publishes only a read-only exact recovered result: %s',
    async (fault) => {
      const header = await observed();
      const controller = new AbortController();
      let calls = 0;
      const client: ProviderSecurityCommandClient = {
        async command(operation, payload) {
          expect(operation).toBe('signin-finalize');
          expect(payload).toMatchObject({ candidate: { credential: 'actual-B' }, actor: { credential: 'actual-A' } });
          calls += 1;
          if (fault === 'unknown') throw new Error('Unknown primary result');
          if (fault === 'later-selection') readSelection.mockResolvedValue({ status: 'unavailable' });
          if (fault === 'aborted') controller.abort();
          return {
            providerSecurityVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000000',
            operation,
            outcome: fault === 'committed' ? 'committed' : 'recovered',
            candidateCredentialHash:
              fault === 'wrong-hash'
                ? 'b'.repeat(64)
                : providerCandidateCredentialHash({ kind: 'canonical-token', credential: 'actual-B' }),
            browserCursor: { ...selected().cursor, ...(fault === 'wrong-cursor' ? { version: 4 } : {}) },
          } as ProviderSecurityOperationReply<typeof operation>;
        },
      };
      const acknowledge = createProviderOwnedSigninAcknowledgment({
        environment: {
          NEXTAUTH_SECRET: secret,
          CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
          CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
        },
        ready: () => true,
        readSelection,
        clientFactory: () => client,
      });
      const response = await acknowledge({ cookieHeader: header, flowHash, signal: controller.signal });
      expect(response.status).toBe(fault === 'success' ? 200 : 503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toEqual({ outcome: fault === 'success' ? 'recovered' : 'unavailable' });
      expect(calls).toBe(1);
    },
  );
});
