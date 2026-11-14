// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLClient } from 'graphql-request';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';

const fixture = vi.hoisted(() => ({
  required: false,
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
}));
vi.mock('../browser-consumer-readiness.web', () => ({
  publicExpoBrowserConsumersReady: () => fixture.required,
}));
vi.mock('../browser-backend-client.web', () => ({
  expoBrowserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        if (!fixture.client) throw new Error('Owned browser fixture is not initialized');
        return Reflect.get(fixture.client, property);
      },
    },
  ),
}));
vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned-fixture' } } }));

let store: typeof import('../auth-store.web');
let interceptor: typeof import('../auth-interceptor.web');
let centralUnavailable: boolean;
let centralSession: unknown;
let performFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let graphqlCalls: RequestInit[];
let issuedLeases: number;
let leaseOwner: ReturnType<typeof selectedOwner> | null;

const legacyIdentity = { userId: 'owned-legacy-A', authSessionId: 'owned-legacy-login-A' };
const legacySession = { user: { id: legacyIdentity.userId }, authSessionId: legacyIdentity.authSessionId };
const legacyBearer = 'owned-legacy-JWE-A';

function selectedOwner() {
  return {
    userId: 'owned-selected-B',
    authSessionId: 'owned-selected-login-B',
    generation: 2,
    cursor: { bindingId: 'b'.repeat(64), version: 3 },
  };
}
function selectedSession() {
  const owner = selectedOwner();
  return {
    user: { id: owner.userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  };
}

beforeEach(async () => {
  vi.resetModules();
  fixture.required = false;
  centralUnavailable = false;
  centralSession = legacySession;
  graphqlCalls = [];
  issuedLeases = 0;
  leaseOwner = null;
  vi.stubGlobal('BroadcastChannel', undefined);
  fixture.client = createBrowserBackendClient({
    ready: () => fixture.required,
    endpoint: 'https://www.boardsesh.com/api/internal/ws-auth',
    fetch: async () =>
      leaseOwner
        ? Response.json({
            status: 'admitted',
            token: `bsbd1_OWNED${++issuedLeases}`,
            usableForMs: 120_000,
            owner: leaseOwner,
          })
        : Response.json({ status: 'unavailable' }, { status: 503 }),
    now: () => 0,
    schedule: () => () => {},
  });
  performFetch = vi.fn<typeof globalThis.fetch>(async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/graphql')) {
      graphqlCalls.push(options);
      return Response.json({ data: { viewer: { id: leaseOwner?.userId ?? legacyIdentity.userId } } });
    }
    if (centralUnavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
    if (url.endsWith('/api/auth/session')) return Response.json(centralSession);
    if (url.endsWith('/api/internal/ws-auth'))
      return Response.json({ authenticated: true, token: legacyBearer, ...legacyIdentity });
    throw new Error('Unexpected owned fixture URL');
  });
  vi.stubGlobal('fetch', performFetch);
  store = await import('../auth-store.web');
  interceptor = await import('../auth-interceptor.web');
});
afterEach(() => {
  fixture.client?.dispose();
  fixture.client = null;
  vi.unstubAllGlobals();
});

function actualClient() {
  return new GraphQLClient('https://owned-backend.example.test/graphql', {
    fetch: (input, options = {}) => interceptor.authenticatedFetch(input, options),
  });
}
async function cacheLegacyIdentity() {
  expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated', token: legacyBearer });
  expect(await store.getAuthToken()).toBe(legacyBearer);
  expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new Error('Unexpected owned request input');
}

describe('required central browser dispatch with an unseen selected account', () => {
  it('checks central admission before a cached legacy credential can send the first mutation', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    centralUnavailable = true;
    const sessionReads = performFetch.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/api/auth/session'),
    ).length;

    await expect(actualClient().request('mutation Owned { ownedMutation }')).rejects.toThrow();

    expect(graphqlCalls).toEqual([]);
    expect(performFetch.mock.calls.filter(([input]) => requestUrl(input).endsWith('/api/auth/session'))).toHaveLength(
      sessionReads + 1,
    );
    expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });

  it('a failed explicit central read cannot leave the old legacy bearer usable for dispatch', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    centralUnavailable = true;
    expect(await store.synchronizeWebSession()).toMatchObject({ status: 'unavailable' });

    await expect(actualClient().request('{ viewer { id } }')).rejects.toThrow();

    expect(graphqlCalls).toEqual([]);
    expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });

  it('previous anonymous admission cannot turn a later required central503 into public dispatch', async () => {
    centralSession = {};
    expect(await store.synchronizeWebSession()).toEqual({ status: 'anonymous' });
    fixture.required = true;
    centralUnavailable = true;

    await expect(actualClient().request('{ publicData }')).rejects.toThrow();

    expect(graphqlCalls).toEqual([]);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });

  it('the unchanged legacy mode can use its cached identity without claiming selected-mode safety', async () => {
    await cacheLegacyIdentity();
    centralUnavailable = true;
    const result = await actualClient().request<{ viewer: { id: string } }>('{ viewer { id } }');
    expect(result.viewer.id).toBe(legacyIdentity.userId);
    expect(graphqlCalls).toHaveLength(1);
    expect(new Headers(graphqlCalls[0].headers).get('Authorization')).toBe(`Bearer ${legacyBearer}`);
  });

  it('a successful required anonymous read removes an unrelated supplied bearer before public dispatch', async () => {
    fixture.required = true;
    centralSession = {};
    await actualClient().request('{ publicData }', undefined, { Authorization: 'Bearer unrelated-old-A' });
    expect(graphqlCalls).toHaveLength(1);
    expect(new Headers(graphqlCalls[0].headers).has('Authorization')).toBe(false);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(true);
    expect(issuedLeases).toBe(0);
  });

  it('a successful legacy response cannot qualify required selected dispatch or call the old token bridge', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    const tokenReads = performFetch.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/api/internal/ws-auth'),
    ).length;
    await expect(actualClient().request('{ viewer { id } }')).rejects.toThrow();
    expect(graphqlCalls).toEqual([]);
    expect(
      performFetch.mock.calls.filter(([input]) => requestUrl(input).endsWith('/api/internal/ws-auth')),
    ).toHaveLength(tokenReads);
    expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });

  it('an unavailable required-mode observation stays sticky when the readiness delegate later closes', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    centralUnavailable = true;
    await expect(store.getAuthToken()).rejects.toThrow();
    fixture.required = false;
    centralUnavailable = false;
    await expect(actualClient().request('{ viewer { id } }')).rejects.toThrow();
    expect(graphqlCalls).toEqual([]);
    expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
  });

  it('first admission of B refuses the old A mutation instead of replaying it under B', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    centralSession = selectedSession();
    leaseOwner = selectedOwner();
    await expect(actualClient().request('mutation Owned { ownedMutation }')).rejects.toMatchObject({
      status: 'superseded',
    });
    expect(graphqlCalls).toEqual([]);
    expect(store.captureConfirmedWebAuthIdentity()).toMatchObject({ userId: selectedOwner().userId });
    expect(issuedLeases).toBe(1);

    const result = await actualClient().request<{ viewer: { id: string } }>('{ viewer { id } }');
    expect(result.viewer.id).toBe(selectedOwner().userId);
    expect(graphqlCalls).toHaveLength(1);
    expect(new Headers(graphqlCalls[0].headers).get('Authorization')).toBe('Bearer bsbd1_OWNED1');
  });

  it('a malformed required central response refuses before transport without erasing the offline account', async () => {
    await cacheLegacyIdentity();
    fixture.required = true;
    performFetch.mockResolvedValueOnce(new Response('{', { headers: { 'Content-Type': 'application/json' } }));
    await expect(actualClient().request('{ viewer { id } }')).rejects.toThrow();
    expect(graphqlCalls).toEqual([]);
    expect(store.captureConfirmedWebAuthIdentity()).toEqual(legacyIdentity);
    expect(store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
});
