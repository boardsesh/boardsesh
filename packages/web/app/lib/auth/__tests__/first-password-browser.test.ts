// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode, decode } from 'next-auth/jwt';
import type { FirstPasswordOperation, FirstPasswordReply } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createFirstPasswordBrowserBroker, FIRST_PASSWORD_BROWSER_PATHS } from '../first-password-browser.server';
import type { FirstPasswordCommandClient, FirstPasswordOperationReply } from '../first-password-command-client.server';
import { captureProviderBrowserContext, providerBindingHash } from '../provider-security-selection.server';
import {
  BROWSER_CORRELATION_COOKIE,
  buildBrowserProofCookieCandidate,
  readBrowserProofCookie,
} from '../browser-proof-cookies.server';
import { openFirstPasswordFlow, firstPasswordFlowCookieName } from '../first-password-flow.server';
import { providerCandidateCredentialHash } from '../provider-security-command-client.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';

const now = new Date('2026-11-14T10:00:00.000Z');
const origin = 'https://www.boardsesh.test';
const secret = 'owned-first-password-browser-cookie-secret-6975';
const bindingToken = 'A'.repeat(43);
const bindingId = providerBindingHash(bindingToken);
const metadata = { firstPasswordVersion: 1 as const, requestId: '12345678-1234-4234-8234-123456789abc' };
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
};
let selection: AdmittedBrowserSelection;
let cookies: string;
const readSelection = vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>();
const execute = vi.fn<(operation: FirstPasswordOperation, payload: unknown) => Promise<FirstPasswordReply>>();
const deliver = vi.fn<(...arguments_: [string, string, string, string]) => Promise<void>>();
const client: FirstPasswordCommandClient = {
  async command(operation, payload) {
    return (await execute(operation, payload)) as FirstPasswordOperationReply<typeof operation>;
  },
};
const clientFactory = vi.fn(() => client);
const rateLimit = vi.fn(() => ({ limited: false, retryAfterSeconds: 0 }));
function broker(overrides: Parameters<typeof createFirstPasswordBrowserBroker>[0] = {}) {
  return createFirstPasswordBrowserBroker({
    environment,
    ready: () => true,
    readSelection,
    clientFactory,
    deliver,
    rateLimit,
    ...overrides,
  });
}
function request(
  operation: keyof typeof FIRST_PASSWORD_BROWSER_PATHS,
  input?: unknown,
  headers: HeadersInit = {},
): Request {
  const requestHeaders = new Headers({
    host: 'www.boardsesh.test',
    origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    cookie: cookies,
  });
  new Headers(headers).forEach((content, name) => requestHeaders.set(name, content));
  return new Request(`${origin}${FIRST_PASSWORD_BROWSER_PATHS[operation]}`, {
    method: operation === 'context' ? 'GET' : 'POST',
    headers: requestHeaders,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
function requested() {
  const context = captureProviderBrowserContext(selection);
  return {
    actorContextKey: context.actorContextKey,
    expectedUserId: context.actor.expectedUserId,
    expectedAuthSessionId: context.actor.expectedAuthSessionId,
  };
}
const pair = (header: string) => header.split(';', 1)[0];
async function start() {
  const result = await broker().run(request('request', requested()), 'request');
  expect(result.status).toBe(200);
  const body = (await result.json()) as { operationKey: string; outcome: string };
  cookies += `; ${pair(result.headers.getSetCookie()[0]!)}`;
  return body.operationKey;
}
function submitted(operationKey: string) {
  return {
    operationKey,
    confirmationToken: 'E'.repeat(43),
    password: ' exact password ',
    confirmPassword: ' exact password ',
  };
}
async function select(kind: 'legacy-jwe' | 'canonical-token') {
  const credential =
    kind === 'canonical-token'
      ? 'actual-owned-canonical-source'
      : await encode({
          secret,
          token: { sub: 'owned-user', authSessionId: 'original-sid', gen: 3, legacy_no_sid: true },
          maxAge: 3600,
        });
  selection = {
    status: 'admitted',
    bindingToken,
    actor: { version: 2, credential: kind === 'canonical-token' ? { kind, token: credential } : { kind, credential } },
    cursor: { bindingId, version: 2, bindingExpiresAt: '2026-11-15T10:00:00.000Z' },
    session: {
      userId: 'owned-user',
      authSessionId: 'original-sid',
      generation: 3,
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true,
      expiresAt: '2026-11-14T11:00:00.000Z',
    },
    user: { id: 'owned-user', email: 'existing-owner@example.test', name: null, image: null },
  };
  cookies = `${BROWSER_CORRELATION_COOKIE}=${bindingToken}; ${buildBrowserProofCookieCandidate({
    cursor: { bindingId, version: selection.cursor.version },
    proof: { kind, rawCredential: credential },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: null,
  })
    .proofHeaders.map(pair)
    .join('; ')}`;
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await select('canonical-token');
  readSelection.mockReset().mockImplementation(async () => structuredClone(selection));
  clientFactory.mockClear();
  deliver.mockReset().mockResolvedValue();
  rateLimit.mockReset().mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  execute.mockReset().mockImplementation(async (operation, payload): Promise<FirstPasswordReply> => {
    if (operation === 'request')
      return {
        ...metadata,
        operation,
        outcome: 'issued',
        challengeToken: 'B'.repeat(43),
        recoveryToken: 'C'.repeat(43),
        browserIntentToken: 'D'.repeat(43),
        browserCursor: selection.cursor,
        expiresAt: '2026-11-14T10:05:00.000Z',
        mailPlan: {
          kind: 'uid-first-password-v1',
          recipient: 'existing-owner@example.test',
          token: 'E'.repeat(43),
          expiresAt: '2026-11-14T10:05:00.000Z',
        },
      };
    if (operation === 'read')
      return {
        ...metadata,
        operation,
        outcome: 'pending',
        expiresAt: '2026-11-14T10:05:00.000Z',
        browserCursor: selection.cursor,
      };
    if (operation === 'prepare')
      return {
        ...metadata,
        operation,
        outcome: 'prepared',
        preparationToken: 'F'.repeat(43),
        credentialProof: {
          version: 1,
          userId: 'owned-user',
          authSessionId: 'original-sid',
          generation: 4,
          authenticatedAt: null,
          linkGuarded: false,
          requiresAccountCutoff: true,
        },
        credentialExpiresAt: selection.session.expiresAt,
        expiresAt: '2026-11-14T10:02:00.000Z',
        browserCursor: selection.cursor,
        proposedCanonicalToken: selection.actor.credential.kind === 'canonical-token' ? 'G'.repeat(43) : null,
        user: {
          ...selection.user,
          email: 'existing-owner@example.test',
          emailVerified: now.toISOString(),
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      };
    if (operation === 'finalize' || operation === 'recover') {
      const command = payload as { candidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } };
      return {
        ...metadata,
        ...(operation === 'finalize'
          ? { operation, outcome: 'committed' as const }
          : { operation, outcome: 'recovered' as const }),
        candidateCredentialHash: providerCandidateCredentialHash(command.candidate),
        browserCursor: {
          ...selection.cursor,
          version: operation === 'finalize' ? selection.cursor.version + 1 : selection.cursor.version,
        },
      };
    }
    throw new Error('Unexpected owned command');
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('account-bound first-password browser composition', () => {
  it('delivers only the backend recipient and keeps mail/command secrets out of JSON', async () => {
    const result = await broker().run(request('request', requested()), 'request');
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).not.toContain('existing-owner');
    expect(text).not.toContain('E'.repeat(43));
    expect(text).not.toContain('B'.repeat(43));
    expect(text).not.toContain('C'.repeat(43));
    const body = JSON.parse(text) as { operationKey: string };
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      'existing-owner@example.test',
      'E'.repeat(43),
      body.operationKey,
      origin,
    );
    expect(result.headers.getSetCookie()[0]).toContain('; Secure; HttpOnly; SameSite=Lax;');
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'publishes an exact %s generation+1 continuation and ACKs actual old+new possession',
    async (kind) => {
      await select(kind);
      const operationKey = await start();
      const result = await broker().run(request('submit', submitted(operationKey)), 'submit');
      expect(result.status).toBe(200);
      expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['request', 'prepare', 'finalize']);
      const publishedPairs = result.headers.getSetCookie().map(pair);
      const replacedNames = new Set(publishedPairs.map((cookie) => cookie.slice(0, cookie.indexOf('='))));
      cookies = [
        ...cookies.split('; ').filter((cookie) => !replacedNames.has(cookie.slice(0, cookie.indexOf('=')))),
        ...publishedPairs,
      ].join('; ');
      const proof = readBrowserProofCookie(cookies, { bindingId, version: 3 });
      expect(proof.status).toBe('present');
      if (proof.status !== 'present') throw new Error('Missing actual published candidate');
      if (kind === 'legacy-jwe')
        expect(await decode({ token: proof.proof.rawCredential, secret })).toMatchObject({
          sub: 'owned-user',
          authSessionId: 'original-sid',
          gen: 4,
          legacy_no_sid: true,
          exp: Date.parse(selection.session.expiresAt) / 1000,
        });
      const framePair = publishedPairs.find((cookie) =>
        cookie.startsWith(`${firstPasswordFlowCookieName(operationKey)}=`),
      )!;
      const frame = openFirstPasswordFlow(framePair.slice(framePair.indexOf('=') + 1), operationKey, secret);
      expect(frame.sourceCredentialProof.authenticatedAt).toBeNull();
      expect(JSON.stringify(frame)).not.toContain(proof.proof.rawCredential);
      selection = {
        ...selection,
        actor: {
          version: 3,
          credential:
            kind === 'canonical-token'
              ? { kind, token: proof.proof.rawCredential }
              : { kind, credential: proof.proof.rawCredential },
        },
        cursor: { ...selection.cursor, version: 3 },
        session: { ...selection.session, generation: 4 },
      };
      const acknowledged = await broker().run(request('acknowledge', { operationKey }), 'acknowledge');
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toEqual({ outcome: 'completed' });
      expect(acknowledged.headers.getSetCookie()).toEqual([]);
      expect(execute.mock.calls.at(-1)?.[0]).toBe('recover');
    },
  );
  it('refuses a stale account UI before creating a challenge or sending mail', async () => {
    const stale = requested();
    selection = {
      ...selection,
      user: { ...selection.user, id: 'different-user' },
      session: { ...selection.session, userId: 'different-user' },
    };
    const result = await broker().run(request('request', stale), 'request');
    expect(result.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('refuses an account change after email confirmation before hashing or finalization', async () => {
    const operationKey = await start();
    execute.mockClear();
    selection = { ...selection, session: { ...selection.session, authSessionId: 'different-sid' } };
    expect((await broker().run(request('submit', submitted(operationKey)), 'submit')).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
  it('never reconstructs or publishes a candidate after an uncertain finalization', async () => {
    const operationKey = await start();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      if (operation === 'finalize') throw new Error('Owned lost commit reply');
      return original(operation, payload);
    });
    const result = await broker().run(request('submit', submitted(operationKey)), 'submit');
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.filter(([operation]) => operation === 'finalize')).toHaveLength(1);
  });
  it('GET context never creates a challenge or delivers mail', async () => {
    const result = await broker().run(request('context'), 'context');
    expect(result.status).toBe(200);
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('accepts a live five-minute challenge issued after private RPC latency', async () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      if (operation !== 'request') return original(operation, payload);
      vi.setSystemTime(new Date(now.getTime() + 500));
      const reply = await original(operation, payload);
      if (reply.outcome !== 'issued') throw new Error('Owned request should issue');
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      return { ...reply, expiresAt, mailPlan: { ...reply.mailPlan, expiresAt } };
    });
    const result = await broker().run(request('request', requested()), 'request');
    expect(result.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('shortens a slightly database-ahead deadline without changing authentication age', async () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const reply = await original(operation, payload);
      if (reply.outcome !== 'issued') return reply;
      const expiresAt = new Date(now.getTime() + 300_250).toISOString();
      return { ...reply, expiresAt, mailPlan: { ...reply.mailPlan, expiresAt } };
    });
    const result = await broker().run(request('request', requested()), 'request');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ expiresAt: new Date(now.getTime() + 300_000).toISOString() });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'refuses %s publication capacity before finalizing a password',
    async (kind) => {
      await select(kind);
      const operationKey = await start();
      const prefix = `${cookies}; unrelated=`;
      cookies = prefix + 'x'.repeat(8150 - Buffer.byteLength(prefix));
      const result = await broker().run(request('submit', submitted(operationKey)), 'submit');
      expect(result.status).toBe(503);
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['request', 'prepare']);
    },
  );
  it('refuses primary generation drift during prepare before finalization', async () => {
    const operationKey = await start();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (operation, payload) => {
      const reply = await original(operation, payload);
      if (operation === 'prepare')
        selection = { ...selection, session: { ...selection.session, generation: selection.session.generation + 1 } };
      return reply;
    });
    const result = await broker().run(request('submit', submitted(operationKey)), 'submit');
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['request', 'prepare']);
  });
  it('refuses an oversized projected browser header before delivering email', async () => {
    const prefix = `${cookies}; unrelated=`;
    cookies = prefix + 'x'.repeat(7304 - Buffer.byteLength(prefix));
    const result = await broker().run(request('request', requested()), 'request');
    expect(result.status).toBe(503);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual(['request']);
  });
  it.each([
    ['origin', 'https://foreign.example.test'],
    ['host', 'foreign.example.test'],
    ['sec-fetch-site', 'cross-site'],
  ])('refuses foreign %s before source admission', async (name, content) => {
    expect((await broker().run(request('request', requested(), { [name]: content }), 'request')).status).toBe(403);
    expect(readSelection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('keeps the code-owned public gate disabled before any service or mail work', async () => {
    const result = await createFirstPasswordBrowserBroker({ environment, readSelection, clientFactory, deliver }).run(
      request('request', requested()),
      'request',
    );
    expect(result.status).toBe(503);
    expect(readSelection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
