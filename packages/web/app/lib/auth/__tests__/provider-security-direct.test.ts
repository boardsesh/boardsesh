// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from 'next-auth/jwt';
import type { ProviderSecurityOperation, ProviderSecurityReply } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { BROWSER_CORRELATION_COOKIE, buildBrowserProofCookieCandidate } from '../browser-proof-cookies.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';
import {
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
  type ProviderSecurityOperationReply,
} from '../provider-security-command-client.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../provider-security-flow.server';
import { captureProviderBrowserContext, providerBindingHash } from '../provider-security-selection.server';
import { createProviderSecurityDirectPublication } from '../provider-security-direct.server';

const now = new Date('2026-11-13T12:00:00.000Z');
const secret = 'owned-direct-provider-publication-cookie-key-6975';
const environment = {
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
};
const metadata = { providerSecurityVersion: 1 as const, requestId: '12345678-1234-4234-8234-123456789abc' };
const bindingToken = 'A'.repeat(43);
const operationKey = providerSecurityOperationKey('B'.repeat(43));
let current: AdmittedBrowserSelection;
let original: AdmittedBrowserSelection;
let flow: ProviderSecurityFlow;
let cookies: string;
let candidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } | undefined;
const readSelection = vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>();
const execute = vi.fn<(operation: ProviderSecurityOperation, payload: unknown) => Promise<ProviderSecurityReply>>();
const client: ProviderSecurityCommandClient = {
  async command(operation, payload) {
    return (await execute(operation, payload)) as ProviderSecurityOperationReply<typeof operation>;
  },
};
const pair = (header: string) => header.split(';', 1)[0];
const actorKey = () => captureProviderBrowserContext(original, now).actorContextKey;
const publisher = (overrides: Parameters<typeof createProviderSecurityDirectPublication>[0] = {}) =>
  createProviderSecurityDirectPublication({
    environment,
    ready: () => true,
    readSelection,
    clientFactory: () => client,
    ...overrides,
  });
const unlink = (input: Partial<Parameters<ReturnType<typeof publisher>['unlink']>[0]> = {}) =>
  publisher().unlink({ cookieHeader: cookies, operationKey, actorContextKey: actorKey(), ...input });

async function fixture(kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token') {
  const raw =
    kind === 'canonical-token'
      ? 'e58a9d4c-b33f-48a9-ae5c-6f6cba39cd08'
      : await encode({
          secret,
          maxAge: 3600,
          token: {
            sub: 'owned-user',
            authSessionId: 'owned-session',
            gen: 3,
            auth_time: Date.parse('2026-08-01T00:00:00.000Z') / 1000,
            link_guarded: true,
            legacy_no_sid: true,
            name: 'Actual source profile',
          },
        });
  original = {
    status: 'admitted',
    bindingToken,
    actor: { version: 2, credential: kind === 'canonical-token' ? { kind, token: raw } : { kind, credential: raw } },
    cursor: { bindingId: providerBindingHash(bindingToken), version: 2, bindingExpiresAt: '2026-11-14T12:00:00.000Z' },
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-11-13T13:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.invalid', name: 'Actual source profile', image: null },
  };
  current = structuredClone(original);
  const captured = captureProviderBrowserContext(original, now);
  flow = {
    version: 1,
    action: 'unlink',
    provider: 'apple',
    methodId: 'f'.repeat(64),
    actorKind: kind,
    actorCredentialHash: captured.credentialHash,
    browserBindingHash: captured.browserCursor.bindingId,
    browserVersion: 2,
    browserBindingExpiresAt: captured.browserCursor.bindingExpiresAt,
    sourceCredentialProof: captured.sourceCredentialProof,
    credentialExpiresAt: captured.credentialExpiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'D'.repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: '2026-11-13T12:15:00.000Z',
    reauthenticationToken: 'E'.repeat(43),
    reauthenticationExpiresAt: '2026-11-13T12:05:00.000Z',
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
  const oldProof = buildBrowserProofCookieCandidate({
    cursor: { bindingId: captured.browserCursor.bindingId, version: 2 },
    proof: { kind, rawCredential: raw },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: null,
  });
  cookies = [
    `${BROWSER_CORRELATION_COOKIE}=${bindingToken}`,
    ...oldProof.proofHeaders.map(pair),
    `${providerSecurityFlowCookieName(operationKey, true)}=${await sealProviderSecurityFlow(flow, secret, now)}`,
  ].join('; ');
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await fixture();
  candidate = undefined;
  readSelection.mockReset().mockImplementation(async () => structuredClone(current));
  execute.mockReset().mockImplementation(async (operation, payload) => {
    if (operation === 'prepare')
      return {
        ...metadata,
        operation,
        outcome: 'prepared',
        preparationToken: 'F'.repeat(43),
        credentialProof: { ...flow.sourceCredentialProof, generation: 4 },
        credentialExpiresAt: flow.credentialExpiresAt,
        expiresAt: '2026-11-13T12:01:00.000Z',
        browserCursor: original.cursor,
        proposedCanonicalToken: original.actor.credential.kind === 'canonical-token' ? 'G'.repeat(43) : null,
        user: { ...original.user, emailVerified: null, createdAt: '2020-01-01T00:00:00.000Z' },
      };
    if (operation === 'finalize') {
      const command = payload as { candidate: NonNullable<typeof candidate> };
      candidate = command.candidate;
      current = {
        ...current,
        actor: {
          version: 3,
          credential:
            candidate.kind === 'canonical-token'
              ? { kind: candidate.kind, token: candidate.credential }
              : { kind: candidate.kind, credential: candidate.credential },
        },
        cursor: { ...original.cursor, version: 3 },
        session: { ...original.session, generation: 4 },
      };
      return {
        ...metadata,
        operation,
        outcome: 'committed',
        browserCursor: current.cursor,
        candidateCredentialHash: providerCandidateCredentialHash(candidate),
      };
    }
    if (operation === 'recover') {
      const command = payload as { candidate: NonNullable<typeof candidate> };
      return {
        ...metadata,
        operation,
        outcome: 'recovered',
        browserCursor: current.cursor,
        candidateCredentialHash: providerCandidateCredentialHash(command.candidate),
      };
    }
    if (operation === 'abort') return { ...metadata, operation, outcome: 'aborted' };
    throw new Error('Unexpected direct command');
  });
});
afterEach(() => vi.useRealTimers());

describe('direct unlink and exact-result ACK publication', () => {
  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'prebuilds future-only %s cookies and ACKs from the next actual header',
    async (kind) => {
      await fixture(kind);
      const before = cookies;
      const result = await unlink();
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ outcome: 'completed' });
      const emitted = result.headers.getSetCookie();
      expect(emitted.length).toBeGreaterThan(0);
      for (const header of emitted) {
        expect(header).toContain('Expires=Fri, 13 Nov 2026 13:00:00 GMT');
        expect(header).not.toMatch(/Max-Age|next-auth|provider-security|browser-binding=/);
        expect(header).toContain(`.${original.cursor.bindingId}.3`);
      }
      expect(candidate?.kind).toBe(kind);
      if (kind === 'legacy-jwe')
        expect(await decode({ token: candidate!.credential, secret })).toMatchObject({
          sub: 'owned-user',
          authSessionId: 'owned-session',
          gen: 4,
          name: 'Actual source profile',
          auth_time: Date.parse(original.session.authenticatedAt!) / 1000,
          exp: Date.parse(original.session.expiresAt) / 1000,
          link_guarded: true,
          legacy_no_sid: true,
        });
      const next = `${before}; ${emitted.map(pair).join('; ')}`;
      const acknowledged = await publisher().acknowledge({ cookieHeader: next, operationKey });
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toEqual({ outcome: 'completed' });
      expect(acknowledged.headers.getSetCookie()).toEqual([]);
      expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize', 'recover']);
    },
  );
  it('default readiness and legacy selectors refuse before any reader or command', async () => {
    for (const settings of [
      { ready: undefined },
      { environment: { ...environment, CURRENT_STORE_PROVIDER_SECURITY_MODE: 'legacy' } },
    ]) {
      expect(
        (await publisher(settings).unlink({ cookieHeader: cookies, operationKey, actorContextKey: actorKey() })).status,
      ).toBe(503);
    }
    expect(readSelection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('wrong UI actor and missing actual proof refuse before prepare', async () => {
    expect((await unlink({ actorContextKey: '0'.repeat(64) })).status).toBe(409);
    expect((await unlink({ cookieHeader: null })).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
  it('full observed-header capacity refuses and aborts preparation before finalize', async () => {
    cookies += `; analytics=${'x'.repeat(7400)}`;
    expect((await unlink()).status).toBe(503);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'abort']);
  });
  it('an actor change after prepare aborts without finalizing or clearing any cookie', async () => {
    readSelection.mockResolvedValueOnce(original).mockResolvedValueOnce({ status: 'conflict' });
    const result = await unlink();
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'abort']);
  });
  it('lost finalizer transport never aborts, retries or emits its held candidate', async () => {
    const baseline = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const result = await baseline(operation, payload);
      if (operation === 'finalize') throw new Error('Owned lost reply after commit');
      return result;
    });
    const result = await unlink();
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize']);
    expect((await publisher().acknowledge({ cookieHeader: cookies, operationKey })).status).toBe(409);
    expect(execute.mock.calls).toHaveLength(2);
  });
  it('unavailable primary never ACKs a committed candidate', async () => {
    const result = await unlink();
    const next = `${cookies}; ${result.headers.getSetCookie().map(pair).join('; ')}`;
    readSelection.mockResolvedValue({ status: 'unavailable' });
    expect((await publisher().acknowledge({ cookieHeader: next, operationKey })).status).toBe(503);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize']);
  });
  it('deadline expiry while preparing aborts before any finalization or cookie', async () => {
    const baseline = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const result = await baseline(operation, payload);
      if (operation === 'prepare') vi.setSystemTime(new Date(now.getTime() + 61_000));
      return result;
    });
    const result = await unlink();
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'abort']);
  });
  it('request cancellation after preparation aborts before publishing a future proof', async () => {
    const controller = new AbortController();
    const baseline = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const result = await baseline(operation, payload);
      if (operation === 'prepare') controller.abort();
      return result;
    });
    const result = await unlink({ signal: controller.signal });
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'abort']);
  });
  it('a mismatched committed receipt is uncertain and never triggers abort or candidate emission', async () => {
    const baseline = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const result = await baseline(operation, payload);
      return result.outcome === 'committed' ? { ...result, candidateCredentialHash: '0'.repeat(64) } : result;
    });
    const result = await unlink();
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize']);
  });
  it('uncertainty after the private ACK withholds public success and all cookie cleanup', async () => {
    const result = await unlink();
    const next = `${cookies}; ${result.headers.getSetCookie().map(pair).join('; ')}`;
    readSelection.mockResolvedValueOnce(structuredClone(current)).mockResolvedValueOnce({ status: 'unavailable' });
    const acknowledged = await publisher().acknowledge({ cookieHeader: next, operationKey });
    expect(acknowledged.status).toBe(503);
    expect(await acknowledged.json()).toEqual({ outcome: 'unavailable' });
    expect(acknowledged.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize', 'recover']);
  });
  it('captures a caller-owned operation frame before its first admission await', async () => {
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => (release = resolve));
    readSelection.mockImplementationOnce(async () => {
      await admitted;
      return structuredClone(current);
    });
    const input: { cookieHeader: string | null; operationKey: string; actorContextKey: string } = {
      cookieHeader: cookies,
      operationKey,
      actorContextKey: actorKey(),
    };
    const pending = publisher().unlink(input);
    input.cookieHeader = null;
    input.operationKey = '0'.repeat(64);
    input.actorContextKey = '0'.repeat(64);
    release();
    expect((await pending).status).toBe(200);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['prepare', 'finalize']);
  });
});
