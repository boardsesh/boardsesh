// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import type { PresentedBrowserSelection } from '../presented-browser-selection.server';
import type { BrowserPasswordCommandClient } from '../browser-password-command-client.server';
const state = vi.hoisted(() => ({ selection: undefined as PresentedBrowserSelection | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => {
      throw new Error('Forbidden legacy writer');
    },
    update: () => {
      throw new Error('Forbidden legacy writer');
    },
  }),
}));
vi.mock('../browser-consumers.server', async (original) => {
  const actual = await original<typeof import('../browser-consumers.server')>();
  return {
    ...actual,
    browserConsumerFacade: { ...actual.browserConsumerFacade, observe: async () => state.selection },
  };
});
import { createBrowserPasswordHandler } from '../browser-password-browser.server';
import { signInCanonicalPassword } from '../canonical-password-signin';
import { BROWSER_PASSWORD_BROWSER_PATHS } from '@boardsesh/auth-protocol/browser-password-browser-v1';
import { BROWSER_COORDINATOR_PUBLIC_PATHS } from '@boardsesh/auth-protocol/browser-coordinator';
import { buildBrowserProofCookieCandidate, readBrowserProofCookie } from '../browser-proof-cookies.server';
import { browserPasswordCandidateHash } from '../browser-password-command-client.server';
import { authOptions } from '../auth-options';
import { createBrowserPasswordAuthPreparation } from '../browser-password-auth.server';
import { captureBrowserPasswordSource } from '../browser-password-selection.server';
import { BROWSER_CORRELATION_COOKIE } from '../browser-proof-cookies.server';
import { browserPasswordFixture, passwordTestEnvironment, passwordTestSelection } from './fixtures/browser-password';
const storage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers(): Promise<Headers>;
  cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
};
beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => storage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => storage.getStore()?.cookies.getAll() ?? [],
  }));
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  for (const [name, content] of Object.entries(passwordTestEnvironment)) vi.stubEnv(name, content);
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
});
afterEach(() => vi.unstubAllEnvs());
function setup(kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token', selected = true, verified = true) {
  const current = browserPasswordFixture(kind, selected);
  current.preparation.verification.verified = verified;
  state.selection = passwordTestSelection(current);
  const csrf = 'actual-installed-csrf-token';
  const digest = createHash('sha256')
    .update(csrf + passwordTestEnvironment.NEXTAUTH_SECRET)
    .digest('hex');
  const header = `${BROWSER_CORRELATION_COOKIE}=${current.source.bindingToken}; __Host-next-auth.csrf-token=${csrf}%7C${digest}; __Secure-next-auth.csrf-token=${csrf}%7C${digest}`;
  const request = new NextRequest(`${passwordTestEnvironment.NEXTAUTH_URL}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      host: 'www.boardsesh.test',
      origin: passwordTestEnvironment.NEXTAUTH_URL,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: header,
    },
    body: new URLSearchParams({
      email: '  exact@example.test ',
      password: '  päss\0word  ',
      csrfToken: csrf,
      callbackUrl: `${passwordTestEnvironment.NEXTAUTH_URL}/settings`,
      json: 'true',
    }),
  });
  const prepared = {
    browserPasswordProtocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001',
    operation: 'prepare' as const,
    outcome: 'prepared' as const,
    ...current,
  };
  const client: BrowserPasswordCommandClient = {
    prepare: vi.fn(async () => prepared),
    abort: vi.fn(
      async () =>
        ({
          browserPasswordProtocolVersion: 1,
          requestId: prepared.requestId,
          operation: 'abort',
          outcome: 'aborted',
        }) as const,
    ),
    finalize: vi.fn(),
    acknowledge: vi.fn(),
  };
  const accepted = vi.fn();
  const base: NextAuthOptions = { ...authOptions, secret: passwordTestEnvironment.NEXTAUTH_SECRET };
  const start = (
    overrides: Partial<NextAuthOptions> = {},
    invoke?: Parameters<typeof createBrowserPasswordAuthPreparation>[3]['invoke'],
  ) =>
    createBrowserPasswordAuthPreparation(
      { ...base, ...overrides },
      request,
      {
        source: captureBrowserPasswordSource(header, state.selection!),
        operationKey: current.preparation.nonceHash,
        canonicalOrigin: passwordTestEnvironment.NEXTAUTH_URL,
        email: '  exact@example.test ',
        password: '  päss\0word  ',
        credentialKind: kind,
      },
      {
        client,
        environment: passwordTestEnvironment,
        passwordAccepted: accepted,
        readSelection: async () => state.selection!,
        invoke:
          invoke ??
          ((actual, context, options) =>
            storage.run(actual, () =>
              (
                NextAuth(options) as (
                  request: NextRequest,
                  context: { params: Promise<{ nextauth: string[] }> },
                ) => Promise<Response>
              )(actual, context),
            )),
      },
    );
  return { current, client, accepted, request, start };
}
describe('installed NextAuth password preparation and actual application JWT callback', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'produces exact unpublished %s candidate without finalization',
    async (kind) => {
      const current = setup(kind);
      const result = await current.start().run();
      expect(result.status).toBe('prepared');
      if (result.status !== 'prepared') throw new Error('Expected preparation');
      expect(current.client.prepare).toHaveBeenCalledOnce();
      expect(current.accepted).toHaveBeenCalledOnce();
      expect(current.client.finalize).not.toHaveBeenCalled();
      expect(current.client.abort).not.toHaveBeenCalled();
      expect(current.client.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ email: '  exact@example.test ', password: '  päss\0word  ', credentialKind: kind }),
      );
      if (result.candidate.kind === 'legacy-jwe') {
        const claims = await decode({
          token: result.candidate.credential,
          secret: passwordTestEnvironment.NEXTAUTH_SECRET,
        });
        expect(claims).toMatchObject({
          sub: 'matched-B',
          authSessionId: 'fresh-B-SID',
          gen: 2,
          auth_time: Date.parse(current.current.preparation.credentialProof.authenticatedAt!) / 1000,
          exp: Date.parse(current.current.preparation.credentialExpiresAt) / 1000,
          link_guarded: true,
        });
      } else expect(result.candidate.token).toBe(current.current.proposedCanonicalToken);
    },
  );
  it('awaits the actual signIn event before returning candidate custody', async () => {
    const current = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const event = vi.fn(async () => gate);
    let settled = false;
    const pending = current
      .start({ events: { signIn: event } })
      .run()
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(current.client.finalize).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe('prepared');
  });
  it('aborts once when an awaited real framework event fails', async () => {
    const current = setup();
    const transaction = current.start({
      events: {
        signIn: async () => {
          throw new Error('private event cause');
        },
      },
    });
    await expect(transaction.run()).rejects.toThrow('AuthBackendUnavailable');
    await transaction.abort();
    expect(current.client.abort).toHaveBeenCalledOnce();
    expect(current.client.finalize).not.toHaveBeenCalled();
  });
  it('preserves correct but unverified outcome and returns limiter budget', async () => {
    const current = setup('canonical-token', true, false);
    const result = await current.start().run();
    expect(result).toMatchObject({
      status: 'framework-result',
      destination: expect.stringContaining('EmailNotVerified'),
    });
    expect(current.accepted).toHaveBeenCalledOnce();
    expect(current.client.abort).toHaveBeenCalledOnce();
    expect(current.client.finalize).not.toHaveBeenCalled();
  });
  it.each(['protected-cookie', 'candidate-mismatch', 'expired-source'] as const)(
    'settles the actual installed response cancellation after %s refusal',
    async (fault) => {
      const current = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let cancelling = false;
      let restoreClock: (() => void) | undefined;
      const transaction = current.start({}, async (request, context, options) => {
        const actual = await storage.run(request, () =>
          (
            NextAuth(options) as (
              request: NextRequest,
              context: { params: Promise<{ nextauth: string[] }> },
            ) => Promise<Response>
          )(request, context),
        );
        const headers = new Headers(actual.headers);
        if (fault === 'protected-cookie')
          headers.append('Set-Cookie', '__Host-boardsesh.browser-proof.forbidden=unsafe; Secure; HttpOnly; Path=/');
        if (fault === 'candidate-mismatch') {
          const cookies = headers.getSetCookie();
          headers.delete('Set-Cookie');
          for (const cookie of cookies)
            headers.append(
              'Set-Cookie',
              cookie.startsWith('__Host-boardsesh.password-signin-pending.')
                ? cookie.replace(current.current.proposedCanonicalToken!, 'A'.repeat(43))
                : cookie,
            );
        }
        if (fault === 'expired-source') {
          const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.current.preparation.expiresAt));
          restoreClock = () => clock.mockRestore();
        }
        return new Response(
          new ReadableStream({
            async cancel(reason) {
              cancelling = true;
              await gate;
              await actual.body?.cancel(reason);
              throw new Error('Owned disposal failure must not replace primary refusal');
            },
          }),
          { status: actual.status, headers },
        );
      });
      let settled = false;
      const pending = transaction
        .run()
        .then(
          () => {
            throw new Error('Unexpected publication');
          },
          (error) => error as unknown,
        )
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(current.client.prepare).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        expect(cancelling).toBe(true);
        expect(settled).toBe(false);
        expect(current.client.abort).not.toHaveBeenCalled();
        expect(current.client.finalize).not.toHaveBeenCalled();
      } finally {
        release();
        await pending;
        restoreClock?.();
      }
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('AuthBackendUnavailable');
      expect(current.client.abort).toHaveBeenCalledOnce();
    },
  );
  it('wrong password produces the installed failure contract without capabilities', async () => {
    const current = setup();
    vi.mocked(current.client.prepare).mockResolvedValue({
      browserPasswordProtocolVersion: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
      operation: 'prepare',
      outcome: 'invalid_credentials',
    });
    const result = await current.start().run();
    expect(result).toMatchObject({
      status: 'framework-result',
      destination: expect.stringContaining('CredentialsSignin'),
    });
    expect(current.accepted).not.toHaveBeenCalled();
    expect(current.client.abort).not.toHaveBeenCalled();
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'admits positive anonymous %s through the distinct password scope',
    async (kind) => {
      const current = setup(kind, false);
      expect((await current.start().run()).status).toBe('prepared');
    },
  );
});

// Request/cookie-jar composition: real canonical client -> mounted handlers ->
// installed NextAuth and app JWT callback. Private command/state is an explicit
// test fixture, not SQL or supported-browser acceptance evidence.
function wholeFixture(
  kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token',
  selected = true,
  sameAccount = false,
) {
  const current = browserPasswordFixture(kind, selected);
  if (sameAccount) {
    current.preparation.credentialProof.userId = 'original-A';
    current.user.id = 'original-A';
  }
  const trace: string[] = [];
  const jar = new Map<string, string>([[BROWSER_CORRELATION_COOKIE, current.source.bindingToken]]);
  const remember = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0],
        separator = pair.indexOf('=');
      if (header.includes('Max-Age=0')) jar.delete(pair.slice(0, separator));
      else jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  };
  const cookieHeader = () => [...jar].map(([name, content]) => name + '=' + content).join('; ');
  if (current.source.state === 'selected')
    for (const header of buildBrowserProofCookieCandidate({
      cursor: { bindingId: current.preparation.browserCursor.bindingId, version: 7 },
      proof: {
        kind,
        rawCredential:
          current.source.actor.credential.kind === 'canonical-token'
            ? current.source.actor.credential.token
            : current.source.actor.credential.credential,
      },
      proofMaxAgeSeconds: 3600,
      observedCookieHeader: null,
      retainObservedProofCookies: true,
    }).headers) {
      const pair = header.split(';', 1)[0],
        separator = pair.indexOf('=');
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  let completed = false;
  let lost = false;
  let holdEvent: Promise<void> | undefined;
  let holdBody: Promise<void> | undefined;
  let holdEncoder: Promise<void> | undefined;
  let holdTarget: Promise<void> | undefined;
  let refuseFinalAck = false;
  const encodedCredentials: string[] = [];
  const sourceSelection = passwordTestSelection(current);
  state.selection = sourceSelection;
  const readSelection = vi.fn(async (header: string | null) => {
    trace.push('primary');
    if (!completed) return sourceSelection;
    await holdTarget;
    const selectedProof = readBrowserProofCookie(header, {
      bindingId: current.preparation.futureBrowserCursor.bindingId,
      version: 8,
    });
    if (
      selectedProof.status !== 'present' ||
      selectedProof.proof.rawCredential !==
        (current.candidate.kind === 'canonical-token' ? current.candidate.token : current.candidate.credential)
    )
      return { status: 'proof-required' as const };
    return passwordTestSelection(current, true);
  });
  const client: BrowserPasswordCommandClient = {
    prepare: vi.fn(async (payload) => {
      trace.push('compare');
      expect(payload.email).toBe('  exact@example.test ');
      expect(payload.password).toBe('  päss\0word  ');
      expect(payload.credentialKind).toBe(kind);
      current.preparation.nonceHash = payload.nonceHash;
      return {
        browserPasswordProtocolVersion: 1 as const,
        requestId: '00000000-0000-4000-8000-000000000001',
        operation: 'prepare' as const,
        outcome: 'prepared' as const,
        ...current,
      };
    }),
    finalize: vi.fn(async (payload) => {
      trace.push('finalize');
      current.candidate = payload.candidate;
      completed = true;
      return {
        browserPasswordProtocolVersion: 1 as const,
        requestId: '00000000-0000-4000-8000-000000000001',
        operation: 'finalize' as const,
        outcome: 'completed' as const,
        cursor: current.preparation.futureBrowserCursor,
        credentialProof: current.preparation.credentialProof,
        credentialExpiresAt: current.preparation.credentialExpiresAt,
        candidateCredentialHash: browserPasswordCandidateHash(payload.candidate),
      };
    }),
    acknowledge: vi.fn(async (payload) => {
      trace.push('ack');
      return completed && !refuseFinalAck
        ? {
            browserPasswordProtocolVersion: 1 as const,
            requestId: '00000000-0000-4000-8000-000000000001',
            operation: 'acknowledge' as const,
            outcome: 'completed' as const,
            cursor: current.preparation.futureBrowserCursor,
            credentialProof: current.preparation.credentialProof,
            credentialExpiresAt: current.preparation.credentialExpiresAt,
            candidateCredentialHash: browserPasswordCandidateHash(payload.candidate),
          }
        : {
            browserPasswordProtocolVersion: 1 as const,
            requestId: '00000000-0000-4000-8000-000000000001',
            operation: 'acknowledge' as const,
            outcome: 'conflict' as const,
          };
    }),
    abort: vi.fn(async () => ({
      browserPasswordProtocolVersion: 1 as const,
      requestId: '00000000-0000-4000-8000-000000000001',
      operation: 'abort' as const,
      outcome: 'aborted' as const,
    })),
  };
  const base: NextAuthOptions = {
    ...authOptions,
    secret: passwordTestEnvironment.NEXTAUTH_SECRET,
    jwt: {
      ...authOptions.jwt,
      encode: async (parameters) => {
        trace.push('encoder');
        await holdEncoder;
        const credential = await encode(parameters);
        encodedCredentials.push(credential);
        trace.push('encoder-settled');
        return credential;
      },
    },
    events: {
      ...authOptions.events,
      signIn: async () => {
        trace.push('event');
        await holdEvent;
        trace.push('event-settled');
      },
    },
  };
  const installed = async (
    request: NextRequest,
    context: { params: Promise<{ nextauth: string[] }> },
    options: NextAuthOptions,
  ) => {
    const response = await storage.run(request, () =>
      (
        NextAuth(options) as (
          request: NextRequest,
          context: { params: Promise<{ nextauth: string[] }> },
        ) => Promise<Response>
      )(request, context),
    );
    if (!holdBody) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(bytes);
          trace.push('body-held');
          await holdBody;
          controller.close();
          trace.push('body-settled');
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
  const admission = vi.fn(() => ({
    limitedResponse: null,
    passwordAccepted: vi.fn(() => {
      trace.push('budget-returned');
    }),
  }));
  const options = {
    environment: passwordTestEnvironment,
    ready: () => true,
    client,
    readSelection,
    authOptions: () => base,
    admission,
    operationKey: () => current.preparation.nonceHash,
    prepareAuth: ((baseOptions, request, input, settings) =>
      createBrowserPasswordAuthPreparation(baseOptions, request, input, {
        ...settings,
        invoke: installed,
      })) as typeof createBrowserPasswordAuthPreparation,
  };
  let locked = false;
  const locks = {
    request: async (_name: string, _settings: unknown, invoke: () => Promise<void>) => {
      expect(locked).toBe(false);
      locked = true;
      try {
        await invoke();
      } finally {
        locked = false;
      }
    },
  };
  const send = vi.fn<typeof fetch>(async (input, init) => {
    expect(locked).toBe(true);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    trace.push(path);
    const headers = new Headers(init?.headers);
    headers.set('host', new URL(passwordTestEnvironment.NEXTAUTH_URL).host);
    headers.set('origin', passwordTestEnvironment.NEXTAUTH_URL);
    headers.set('sec-fetch-site', 'same-origin');
    headers.set('cookie', cookieHeader());
    const request = new NextRequest(new Request(url, { ...init, headers }));
    let response: Response;
    if (path === '/api/auth/csrf')
      response = await storage.run(request, () =>
        (
          NextAuth(base) as (
            request: NextRequest,
            context: { params: Promise<{ nextauth: string[] }> },
          ) => Promise<Response>
        )(request, { params: Promise.resolve({ nextauth: ['csrf'] }) }),
      );
    else if (path === BROWSER_COORDINATOR_PUBLIC_PATHS.observe) {
      const selection = await readSelection(cookieHeader());
      response = Response.json(
        selection.status === 'admitted' || selection.status === 'anonymous'
          ? { status: 'ready', cursor: { bindingId: selection.cursor.bindingId, version: selection.cursor.version } }
          : { status: 'unavailable' },
      );
    } else {
      const entry = Object.entries(BROWSER_PASSWORD_BROWSER_PATHS).find(([, route]) => route === path);
      if (!entry) throw new Error('Unexpected path');
      response = await createBrowserPasswordHandler(
        entry[0] as keyof typeof BROWSER_PASSWORD_BROWSER_PATHS,
        options,
      )(request);
    }
    if (lost && path === BROWSER_PASSWORD_BROWSER_PATHS.commit) {
      lost = false;
      throw new Error('Lost actual HTTP response after durable completion');
    }
    remember(response);
    return response;
  });
  const preflight = vi.fn(async () => {
    expect(locked).toBe(false);
    trace.push('preflight');
    return { bindingId: current.preparation.browserCursor.bindingId, version: 7 };
  });
  const run = () =>
    signInCanonicalPassword(
      {
        canonicalOrigin: passwordTestEnvironment.NEXTAUTH_URL,
        email: '  exact@example.test ',
        password: '  päss\0word  ',
        callbackUrl: '/settings',
        redirect: false,
        signal: new AbortController().signal,
      },
      { currentOrigin: passwordTestEnvironment.NEXTAUTH_URL, locks, preflight, send, navigate: vi.fn() },
    );
  return {
    current,
    trace,
    encodedCredentials,
    jar,
    send,
    client,
    run,
    readSelection,
    preflight,
    admission,
    lose: () => {
      lost = true;
    },
    setHoldEvent: (pending: Promise<void>) => {
      holdEvent = pending;
    },
    setHoldEncoder: (pending: Promise<void>) => {
      holdEncoder = pending;
    },
    setHoldBody: (pending: Promise<void>) => {
      holdBody = pending;
    },
    setHoldTarget: (pending: Promise<void>) => {
      holdTarget = pending;
    },
    denyAck: () => {
      refuseFinalAck = true;
    },
    get locked() {
      return locked;
    },
  };
}
describe('canonical client to mounted endpoints to installed NextAuth cookie jar', () => {
  it.each([
    ['canonical-token', true, false],
    ['legacy-jwe', true, false],
    ['canonical-token', false, false],
    ['canonical-token', true, true],
  ] as const)(
    'publishes %s selected=%s sameAccount=%s with normal fixed expiry',
    async (kind, selected, sameAccount) => {
      const current = wholeFixture(kind, selected, sameAccount);
      expect(await current.run()).toMatchObject({ ok: true, url: passwordTestEnvironment.NEXTAUTH_URL + '/settings' });
      expect(current.client.prepare).toHaveBeenCalledOnce();
      expect(current.client.finalize).toHaveBeenCalledOnce();
      expect(current.client.acknowledge).toHaveBeenCalledTimes(2);
      expect(current.client.abort).not.toHaveBeenCalled();
      expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(false);
      expect(current.trace.indexOf('event-settled')).toBeLessThan(
        current.trace.indexOf(BROWSER_PASSWORD_BROWSER_PATHS.commit),
      );
      if (current.current.candidate.kind === 'legacy-jwe') {
        const actual = await decode({
          token: current.current.candidate.credential,
          secret: passwordTestEnvironment.NEXTAUTH_SECRET,
        });
        expect(actual?.exp).toBe(Date.parse(current.current.preparation.credentialExpiresAt) / 1000);
        expect(actual?.auth_time).toBe(Date.parse(current.current.preparation.credentialProof.authenticatedAt!) / 1000);
      }
    },
  );
  it('next explicit action recovers actual lost commit response before any preflight or prepare', async () => {
    const current = wholeFixture();
    current.lose();
    await expect(current.run()).rejects.toThrow('Lost actual HTTP response');
    expect(current.client.finalize).toHaveBeenCalledOnce();
    expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(true);
    current.trace.length = 0;
    current.preflight.mockClear();
    expect(await current.run()).toMatchObject({ ok: true });
    expect(current.trace.slice(0, 4)).toEqual([BROWSER_PASSWORD_BROWSER_PATHS.acknowledge, 'ack', 'primary', 'ack']);
    expect(current.preflight).not.toHaveBeenCalled();
    expect(current.client.prepare).toHaveBeenCalledOnce();
    expect(current.client.finalize).toHaveBeenCalledOnce();
  });
  it.each(['event', 'body'] as const)(
    'withholds first custody response while actual framework %s is held',
    async (held) => {
      const current = wholeFixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (held === 'event') current.setHoldEvent(gate);
      else current.setHoldBody(gate);
      let done = false;
      const pending = current.run().finally(() => {
        done = true;
      });
      await vi.waitFor(() => expect(current.trace).toContain(held === 'event' ? 'event' : 'body-held'));
      expect(done).toBe(false);
      expect(current.locked).toBe(true);
      expect(current.client.finalize).not.toHaveBeenCalled();
      expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(false);
      release();
      expect(await pending).toMatchObject({ ok: true });
    },
  );
  it('awaits the real legacy encoder before custody or durable finalization', async () => {
    // This positive controls event ownership, not a crossing of epoch seconds.
    // Keep the real encoder and exact frozen-expiry check deterministic.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const current = wholeFixture('legacy-jwe');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      current.setHoldEncoder(gate);
      const pending = current.run();
      await vi.waitFor(() => expect(current.trace).toContain('encoder'));
      expect(current.trace).not.toContain('encoder-settled');
      expect(current.client.finalize).not.toHaveBeenCalled();
      expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(false);
      release();
      expect(await pending).toMatchObject({ ok: true });
    } finally {
      clock.mockRestore();
    }
  });
  it('refuses an actual legacy encoder crossing one epoch second without freshening authentication age', async () => {
    let milliseconds = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => milliseconds);
    let release = () => {};
    try {
      const current = wholeFixture('legacy-jwe');
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      current.setHoldEncoder(gate);
      const pending = current.run().catch((error: unknown) => error);
      await vi.waitFor(() => expect(current.trace).toContain('encoder'));
      expect(current.encodedCredentials).toEqual([]);
      milliseconds += 1000;
      release();
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(current.client.finalize).not.toHaveBeenCalled();
      expect(current.client.abort).toHaveBeenCalledOnce();
      expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(false);
      expect(current.encodedCredentials).toHaveLength(1);
      const claims = await decode({
        token: current.encodedCredentials[0],
        secret: passwordTestEnvironment.NEXTAUTH_SECRET,
      });
      expect(claims?.exp).toBe(Date.parse(current.current.preparation.credentialExpiresAt) / 1000 + 1);
      expect(claims?.auth_time).toBe(Date.parse(current.current.preparation.credentialProof.authenticatedAt!) / 1000);
    } finally {
      release();
      clock.mockRestore();
    }
  });
  it('holds final target primary admission then refuses changed final ACK without auth cookie publication', async () => {
    const current = wholeFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    current.setHoldTarget(gate);
    const pending = current.run();
    await vi.waitFor(() => expect(current.client.finalize).toHaveBeenCalledOnce());
    expect(current.client.acknowledge).not.toHaveBeenCalled();
    current.denyAck();
    release();
    await expect(pending).rejects.toThrow();
    expect(current.client.abort).not.toHaveBeenCalled();
    expect([...current.jar.keys()].some((name) => name.includes('.8'))).toBe(false);
    expect([...current.jar.keys()].some((name) => name.startsWith('__Host-boardsesh.password-signin.'))).toBe(true);
  });
  it('whole observed cookie capacity rejects before the actual finalizer', async () => {
    const current = wholeFixture();
    current.jar.set('unrelated-padding', 'a'.repeat(6000));
    await expect(current.run()).rejects.toThrow();
    expect(current.client.finalize).not.toHaveBeenCalled();
    expect(current.client.abort).toHaveBeenCalledOnce();
    expect(current.jar.get('unrelated-padding')).toHaveLength(6000);
  });
});
