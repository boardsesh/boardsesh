// @vitest-environment node
import { createHash } from 'node:crypto';
import { decode, encode } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSourceCredential } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { BrowserRenewalReply } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { BROWSER_RENEWAL_BROWSER_PATHS } from '@boardsesh/auth-protocol/browser-renewal-browser-v1';
import { BROWSER_COORDINATOR_PUBLIC_PATHS } from '@boardsesh/auth-protocol/browser-coordinator';
vi.mock('server-only', () => ({}));
import { createBrowserRenewalBrowserBroker } from '../browser-renewal-browser.server';
import { createBrowserRenewalRecovery } from '../browser-renewal-recovery.server';
import { browserRenewalSourceHash, type BrowserRenewalCommandClient } from '../browser-renewal-command-client.server';
import type { BrowserBindingCommandClient } from '../browser-binding-command-client.server';
import {
  BROWSER_CORRELATION_COOKIE,
  BROWSER_PROOF_COOKIE_PREFIX,
  buildBrowserProofCookieCandidate,
  readBrowserProofCookie,
} from '../browser-proof-cookies.server';
import { BROWSER_RENEWAL_CARRIER_PREFIX } from '../browser-renewal-carrier.server';
import { readPresentedBrowserSelection } from '../presented-browser-selection.server';

const origin = 'https://www.actual-renewal-broker.example.test';
const secret = 'owned-broker-actual-nextauth-and-custody-key-6975';
const bindingToken = Buffer.alloc(32, 19).toString('base64url');
const bindingId = createHash('sha256').update(bindingToken).digest('hex');
const requestId = 'e363934b-b7ba-41ba-a279-52185daa100e';
const metadata = { browserBindingProtocolVersion: 1 as const, requestId };
const renewalMetadata = { browserRenewalProtocolVersion: 1 as const, requestId };
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_RENEWAL_MODE: 'backend-staging',
};
let milliseconds: number;
beforeEach(() => {
  milliseconds = Math.floor(Date.now() / 1000) * 1000;
  vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
});
afterEach(() => vi.restoreAllMocks());
async function fixture(kind: 'canonical-token' | 'legacy-jwe' = 'legacy-jwe', fresh = false, unknownAge = false) {
  const age = unknownAge ? null : new Date(milliseconds - 2 * 86400000).toISOString();
  const source: BrowserSourceCredential =
    kind === 'canonical-token'
      ? { kind, token: Buffer.alloc(32, 31).toString('base64url') }
      : {
          kind,
          credential: await encode({
            secret,
            maxAge: fresh ? 30 * 86400 : 3600,
            token: {
              sub: 'owner-A',
              authSessionId: 'original-SID',
              gen: 4,
              ...(age ? { auth_time: Date.parse(age) / 1000, link_guarded: true } : {}),
            },
          }),
        };
  const sourceExpiresAt = new Date(milliseconds + (fresh ? 30 * 86400000 : 3600000)).toISOString();
  const state = {
    anonymous: false,
    cursor: {
      bindingId,
      version: 3,
      bindingExpiresAt: new Date(milliseconds + (fresh ? 30 : 1) * 86400000).toISOString(),
    },
    session: {
      userId: 'owner-A',
      authSessionId: 'original-SID',
      generation: 4,
      authenticatedAt: age,
      linkGuarded: age !== null,
      requiresAccountCutoff: false,
      expiresAt: sourceExpiresAt,
    },
    user: { id: 'owner-A', email: 'stored@example.test', name: null, image: null },
    credential: source,
  };
  const jar = new Map<string, string>([[BROWSER_CORRELATION_COOKIE, bindingToken]]);
  const initial = buildBrowserProofCookieCandidate({
    cursor: { bindingId, version: 3 },
    proof: { kind, rawCredential: source.kind === 'canonical-token' ? source.token : source.credential },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: `${BROWSER_CORRELATION_COOKIE}=${bindingToken}`,
    retainObservedProofCookies: true,
  });
  const apply = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0],
        separator = pair.indexOf('=');
      const name = pair.slice(0, separator),
        content = pair.slice(separator + 1);
      if (content) jar.set(name, content);
      else jar.delete(name);
    }
  };
  apply(new Response(null, { headers: initial.headers.map((header) => ['Set-Cookie', header]) }));
  const header = () => [...jar].map(([name, content]) => `${name}=${content}`).join('; ');
  const trace: string[] = [];
  const faults = new Set<string>();
  const read = vi.fn<BrowserBindingCommandClient['read']>(async (payload) => {
    trace.push(`read:${payload.actor?.version}`);
    if (state.anonymous) return { ...metadata, operation: 'read', outcome: 'anonymous', cursor: { ...state.cursor } };
    const actor = payload.actor;
    let admitted = actor?.version === state.cursor.version && actor.credential.kind === kind;
    if (admitted && actor?.credential.kind === 'canonical-token')
      admitted = state.credential.kind === 'canonical-token' && actor.credential.token === state.credential.token;
    if (admitted && actor?.credential.kind === 'legacy-jwe') {
      const actual = await decode({ secret, token: actor.credential.credential });
      admitted = Boolean(
        actual &&
        actual.sub === state.session.userId &&
        actual.authSessionId === state.session.authSessionId &&
        actual.gen === state.session.generation &&
        actual.exp === Date.parse(state.session.expiresAt) / 1000,
      );
    }
    return admitted
      ? {
          ...metadata,
          operation: 'read',
          outcome: 'admitted',
          cursor: { ...state.cursor },
          session: { ...state.session },
          user: { ...state.user },
        }
      : { ...metadata, operation: 'read', outcome: 'denied' };
  });
  const binding: BrowserBindingCommandClient = {
    bootstrap: vi.fn(),
    intent: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    read,
    describe: vi.fn(async () => ({
      ...metadata,
      operation: 'describe' as const,
      outcome: 'known' as const,
      state: state.anonymous ? ('anonymous' as const) : ('selected' as const),
      credentialKind: state.anonymous ? null : kind,
      cursor: { ...state.cursor },
    })),
  };
  let saved: Extract<BrowserRenewalReply, { outcome: 'prepared' }> | null = null;
  let committedHash: string | null = null;
  const prepare = vi.fn<BrowserRenewalCommandClient['prepare']>(async (payload) => {
    trace.push('prepare');
    const target = new Date(milliseconds + 30 * 86400000).toISOString();
    saved = {
      ...renewalMetadata,
      operation: 'prepare',
      outcome: 'prepared',
      operationToken: Buffer.alloc(32, 41).toString('base64url'),
      preparationToken: Buffer.alloc(32, 42).toString('base64url'),
      preparation: {
        version: 1,
        credentialKind: kind,
        sourceCredentialProof: {
          version: 1,
          userId: state.session.userId,
          authSessionId: state.session.authSessionId,
          generation: state.session.generation,
          authenticatedAt: state.session.authenticatedAt,
          linkGuarded: state.session.linkGuarded,
        },
        sourceCredentialHash: browserRenewalSourceHash(payload.actor.credential),
        sourceExpiresAt: state.session.expiresAt,
        browserCursor: { ...state.cursor },
        intentRevision: 2,
        futureBrowserCursor: { ...state.cursor, version: state.cursor.version + 1, bindingExpiresAt: target },
        targetExpiresAt: target,
        preparedAt: new Date(milliseconds).toISOString(),
        expiresAt: new Date(milliseconds + 60000).toISOString(),
      },
    };
    return structuredClone(saved);
  });
  const acknowledge = vi.fn<BrowserRenewalCommandClient['acknowledge']>(async (payload) => {
    trace.push('acknowledge');
    if (faults.has('ack-unavailable')) return { ...renewalMetadata, operation: 'acknowledge', outcome: 'unavailable' };
    if (
      !saved ||
      !committedHash ||
      committedHash !== browserRenewalSourceHash(payload.candidate) ||
      payload.operationToken !== saved.operationToken
    )
      return { ...renewalMetadata, operation: 'acknowledge', outcome: 'conflict' };
    return {
      ...renewalMetadata,
      operation: 'acknowledge',
      outcome: 'completed',
      cursor: saved.preparation.futureBrowserCursor,
      credentialProof: saved.preparation.sourceCredentialProof,
      credentialExpiresAt: saved.preparation.targetExpiresAt,
    };
  });
  const finalize = vi.fn<BrowserRenewalCommandClient['finalize']>(async (payload) => {
    trace.push('finalize');
    if (!saved) throw new Error('Owned fixture requires a real preparation');
    if (faults.has('finalize-unavailable')) throw new Error('unsafe-private-query-and-credential-cause');
    committedHash = browserRenewalSourceHash(payload.candidate);
    state.cursor = { ...saved.preparation.futureBrowserCursor };
    state.session.expiresAt = saved.preparation.targetExpiresAt;
    state.credential = { ...payload.candidate };
    if (faults.has('lost-after-commit')) throw new Error('unsafe-private-unknown-commit-cause');
    return {
      ...renewalMetadata,
      operation: 'finalize',
      outcome: 'completed',
      cursor: state.cursor,
      credentialProof: saved.preparation.sourceCredentialProof,
      credentialExpiresAt: state.session.expiresAt,
    };
  });
  const renewal: BrowserRenewalCommandClient = { prepare, acknowledge, finalize };
  const readSelection = vi.fn((cookies: string | null) =>
    readPresentedBrowserSelection(cookies, { environment, client: binding }),
  );
  const options = {
    environment,
    ready: () => true,
    readSelection,
    bindingFactory: () => binding,
    renewalFactory: () => renewal,
    rateLimit: () => false,
  };
  const broker = createBrowserRenewalBrowserBroker(options),
    recover = createBrowserRenewalRecovery(options);
  const request = (operation: 'prepare' | 'commit' | 'observe', body?: unknown, extraHeaders: HeadersInit = {}) =>
    new Request(
      `http://internal.invalid${operation === 'observe' ? BROWSER_COORDINATOR_PUBLIC_PATHS.observe : BROWSER_RENEWAL_BROWSER_PATHS[operation]}`,
      {
        method: operation === 'observe' ? 'GET' : 'POST',
        headers: {
          host: new URL(origin).host,
          origin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          cookie: header(),
          ...Object.fromEntries(new Headers(extraHeaders)),
        },
        ...(operation === 'observe' ? {} : { body: JSON.stringify(body) }),
      },
    );
  const begin = async () => {
    const response = await broker.prepare(request('prepare', { expectedCursor: { bindingId, version: 3 } }));
    const body = (await response.json()) as { status: string; operationKey: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe('prepared');
    apply(response);
    return { response, operationKey: body.operationKey };
  };
  return {
    state,
    jar,
    header,
    apply,
    read,
    binding,
    renewal,
    prepare,
    acknowledge,
    finalize,
    trace,
    faults,
    readSelection,
    options,
    broker,
    recover,
    request,
    begin,
    source,
  };
}
describe('actual credential browser renewal publication', () => {
  for (const kind of ['legacy-jwe', 'canonical-token'] as const)
    it.each([false, true])(
      `${kind}: delivers custody before commit and cleans up only after real current proof, unknown age=%s`,
      async (unknownAge) => {
        const current = await fixture(kind, false, unknownAge);
        const started = await current.begin();
        expect(current.finalize).not.toHaveBeenCalled();
        expect(
          started.response.headers.getSetCookie().some((cookie) => cookie.startsWith(BROWSER_CORRELATION_COOKIE + '=')),
        ).toBe(true);
        expect(
          started.response.headers.getSetCookie().every((cookie) => !cookie.startsWith(BROWSER_PROOF_COOKIE_PREFIX)),
        ).toBe(true);
        const completion = await current.broker.commit(
          current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
        );
        expect(completion.status).toBe(200);
        expect(current.finalize).toHaveBeenCalledOnce();
        expect(completion.headers.getSetCookie().every((cookie) => !cookie.includes('Max-Age=0'))).toBe(true);
        current.apply(completion);
        expect([...current.jar.keys()].some((name) => name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX))).toBe(true);
        const cleanup = await current.recover(current.request('observe'));
        expect(cleanup?.status).toBe(200);
        current.apply(cleanup!);
        expect([...current.jar.keys()].some((name) => name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX))).toBe(false);
        expect(readBrowserProofCookie(current.header(), { bindingId, version: 3 }).status).toBe('missing');
        expect(readBrowserProofCookie(current.header(), { bindingId, version: 4 }).status).toBe('present');
        expect(await current.readSelection(current.header())).toMatchObject({
          status: 'admitted',
          cursor: { version: 4 },
          session: {
            userId: 'owner-A',
            authSessionId: 'original-SID',
            generation: 4,
            authenticatedAt: unknownAge ? null : new Date(milliseconds - 2 * 86400000).toISOString(),
          },
        });
        expect(current.finalize).toHaveBeenCalledOnce();
        expect(JSON.stringify(await cleanup!.json())).not.toContain('owner-A');
      },
    );
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    '%s: lost finalizer headers recover only through exact read-only ACK',
    async (kind) => {
      const current = await fixture(kind);
      const started = await current.begin();
      current.faults.add('lost-after-commit');
      const result = await current.broker.commit(
        current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
      );
      expect(result.status).toBe(503);
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(JSON.stringify(await result.json())).not.toContain('unsafe-private');
      expect(await current.readSelection(current.header())).toMatchObject({ status: 'proof-required' });
      current.trace.length = 0;
      const recovered = await current.recover(current.request('observe'));
      expect(recovered?.status).toBe(200);
      expect(current.trace.indexOf('acknowledge')).toBeLessThan(current.trace.indexOf('read:4'));
      expect(recovered!.headers.getSetCookie().every((cookie) => !cookie.includes('Max-Age=0'))).toBe(true);
      current.apply(recovered!);
      expect(current.finalize).toHaveBeenCalledOnce();
      expect(await current.readSelection(current.header())).toMatchObject({
        status: 'admitted',
        cursor: { version: 4 },
      });
    },
  );
  it('never finalizes an uncommitted carrier during GET observation', async () => {
    const current = await fixture();
    await current.begin();
    expect(await current.recover(current.request('observe'))).toBeNull();
    expect(current.finalize).not.toHaveBeenCalled();
    expect(current.state.cursor.version).toBe(3);
  });
  it('limits recovery before any private primary read or ACK', async () => {
    const current = await fixture();
    await current.begin();
    current.readSelection.mockClear();
    const rateLimit = vi.fn(() => true);
    const recover = createBrowserRenewalRecovery({ ...current.options, rateLimit });
    const response = await recover(current.request('observe'));
    expect(response?.status).toBe(429);
    expect(response?.headers.getSetCookie()).toEqual([]);
    expect(rateLimit).toHaveBeenCalledOnce();
    expect(current.readSelection).not.toHaveBeenCalled();
    expect(current.acknowledge).not.toHaveBeenCalled();
  });
  it('keeps matched ACK unavailability distinct from an unrelated malformed carrier', async () => {
    const current = await fixture();
    const started = await current.begin();
    const committed = await current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    current.apply(committed);
    current.jar.set(BROWSER_RENEWAL_CARRIER_PREFIX + 'f'.repeat(64), 'unrelated-invalid-custody');
    current.faults.add('ack-unavailable');
    const response = await current.recover(current.request('observe'));
    expect(response?.status).toBe(503);
    expect(response?.headers.getSetCookie()).toEqual([]);
    expect(current.finalize).toHaveBeenCalledOnce();
    expect([...current.jar.keys()].some((name) => name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX))).toBe(true);
  });
  it('rechecks the primary candidate after a held recovered visibility read', async () => {
    const current = await fixture();
    const started = await current.begin();
    current.faults.add('lost-after-commit');
    await current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    let observed!: () => void;
    const entered = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    current.readSelection.mockImplementationOnce(async () => {
      observed();
      await release;
      return { status: 'proof-required' };
    });
    const pending = current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    await entered;
    current.state.cursor.version++;
    current.state.session.authSessionId = 'replacement-owner-session';
    finish();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.finalize).toHaveBeenCalledOnce();
  });
  it.each(['authSessionId', 'generation', 'authenticatedAt', 'userId', 'cursor', 'expiresAt'] as const)(
    'refuses source %s drift after buffering and before invoking the finalizer',
    async (field) => {
      const current = await fixture();
      const started = await current.begin();
      const readSelection = current.readSelection.getMockImplementation()!;
      current.readSelection.mockClear();
      current.readSelection.mockImplementation(async (header) => {
        const selected = await readSelection(header);
        if (current.readSelection.mock.calls.length !== 2 || selected.status !== 'admitted') return selected;
        const changed = {
          ...selected,
          session: { ...selected.session },
          user: { ...selected.user },
          cursor: { ...selected.cursor },
        };
        if (field === 'authSessionId') changed.session.authSessionId = 'another-SID';
        if (field === 'generation') changed.session.generation++;
        if (field === 'authenticatedAt') changed.session.authenticatedAt = new Date(milliseconds).toISOString();
        if (field === 'userId') changed.user.id = 'another-owner';
        if (field === 'cursor') changed.cursor.version++;
        if (field === 'expiresAt') changed.session.expiresAt = new Date(milliseconds + 2000).toISOString();
        return changed;
      });
      const response = await current.broker.commit(
        current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
      );
      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(current.finalize).not.toHaveBeenCalled();
      expect(current.state.cursor.version).toBe(3);
    },
  );
  it('keeps custody after cancellation following a durable commit and recovers without another finalizer', async () => {
    const current = await fixture();
    const started = await current.begin();
    let committed!: () => void;
    const completed = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const finalize = current.finalize.getMockImplementation()!;
    current.finalize.mockImplementation(async (payload) => {
      const reply = await finalize(payload);
      committed();
      await release;
      return reply;
    });
    const controller = new AbortController();
    const original = current.request('commit', {
      expectedCursor: { bindingId, version: 3 },
      operationKey: started.operationKey,
    });
    const pending = current.broker.commit(new Request(original, { signal: controller.signal }));
    await completed;
    controller.abort();
    finish();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    const recovered = await current.recover(current.request('observe'));
    expect(recovered?.status).toBe(200);
    current.apply(recovered!);
    expect(await current.readSelection(current.header())).toMatchObject({ status: 'admitted', cursor: { version: 4 } });
    expect(current.finalize).toHaveBeenCalledOnce();
  });
  it('retains custody and every old proof when installed current proof is incomplete', async () => {
    const current = await fixture();
    const started = await current.begin();
    const committed = await current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    expect(committed.status).toBe(200);
    // Losing even the sole future proof header models a partially applied response.
    const futureName = `${BROWSER_PROOF_COOKIE_PREFIX}${bindingId}.4`;
    for (const cookie of committed.headers.getSetCookie())
      if (!cookie.startsWith(futureName)) current.apply(new Response(null, { headers: { 'Set-Cookie': cookie } }));
    const recovered = await current.recover(current.request('observe'));
    expect(recovered?.status).toBe(200);
    expect(recovered!.headers.getSetCookie().every((cookie) => !cookie.includes('Max-Age=0'))).toBe(true);
    expect(readBrowserProofCookie(current.header(), { bindingId, version: 3 }).status).toBe('present');
    expect([...current.jar.keys()].some((name) => name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX))).toBe(true);
    expect(current.finalize).toHaveBeenCalledOnce();
  });
  it('rejects a stale expected cursor before preparation or custody publication', async () => {
    const current = await fixture();
    const result = await current.broker.prepare(
      current.request('prepare', { expectedCursor: { bindingId, version: 2 } }),
    );
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(current.prepare).not.toHaveBeenCalled();
  });
  it('requires actual carrier cookies, never just their public selector', async () => {
    const current = await fixture();
    const started = await current.begin();
    for (const name of current.jar.keys())
      if (name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX)) current.jar.delete(name);
    const result = await current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    expect(result.status).toBe(503);
    expect(current.finalize).not.toHaveBeenCalled();
  });
  it('buffers full next-request capacity before invoking the finalizer', async () => {
    const current = await fixture('canonical-token');
    for (let index = 0; index < 125; index++) current.jar.set(`p${index}`, 'x');
    const started = await current.begin();
    expect(current.jar.size).toBe(128);
    const result = await current.broker.commit(
      current.request('commit', { expectedCursor: { bindingId, version: 3 }, operationKey: started.operationKey }),
    );
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(current.finalize).not.toHaveBeenCalled();
  });
  it('keeps a complete current proof usable with a malformed unrelated carrier', async () => {
    const current = await fixture();
    current.jar.set(BROWSER_RENEWAL_CARRIER_PREFIX + 'malformed', 'invalid');
    expect(await current.recover(current.request('observe'))).toBeNull();
    expect(current.acknowledge).not.toHaveBeenCalled();
    expect(await current.readSelection(current.header())).toMatchObject({ status: 'admitted' });
  });
  it('requires all public gates before any primary read or RPC', async () => {
    const current = await fixture();
    const disabled = createBrowserRenewalBrowserBroker({ ...current.options, ready: undefined });
    expect(
      (await disabled.prepare(current.request('prepare', { expectedCursor: { bindingId, version: 3 } }))).status,
    ).toBe(503);
    expect(current.readSelection).not.toHaveBeenCalled();
    expect(current.prepare).not.toHaveBeenCalled();
  });
  it('uses an explicit anonymous no-op without refreshing its finite physical binding lease', async () => {
    const current = await fixture();
    current.state.anonymous = true;
    current.state.cursor.version = 0;
    const result = await current.broker.prepare(
      current.request('prepare', { expectedCursor: { bindingId, version: 0 } }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'anonymous', cursor: { version: 0 } });
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(current.prepare).not.toHaveBeenCalled();
  });
  it('keeps recently rolled selected views stable while refreshing correlation custody', async () => {
    const current = await fixture('canonical-token', true);
    const result = await current.broker.prepare(
      current.request('prepare', { expectedCursor: { bindingId, version: 3 } }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'current', cursor: { version: 3 } });
    expect(result.headers.getSetCookie()).toHaveLength(1);
    expect(result.headers.getSetCookie()[0]).toContain('Max-Age=2592000');
    expect(current.prepare).not.toHaveBeenCalled();
    expect(current.finalize).not.toHaveBeenCalled();
  });
  it.each(['host', 'origin', 'body'] as const)('refuses untrusted %s before any preparation', async (fault) => {
    const current = await fixture();
    const headers = new Headers();
    if (fault === 'host') headers.set('host', 'other.example.test');
    if (fault === 'origin') headers.set('origin', 'https://other.example.test');
    const result = await current.broker.prepare(
      current.request(
        'prepare',
        { expectedCursor: { bindingId, version: 3 }, ...(fault === 'body' ? { userId: 'claimed' } : {}) },
        headers,
      ),
    );
    expect(result.status).toBe(fault === 'body' ? 400 : 403);
    expect(current.prepare).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
});
