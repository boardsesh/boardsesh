// @vitest-environment node
import { GraphQLClient } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';
import { captureBrowserBackendRequestScope, createBrowserBackendGraphQLTransport } from '../browser-backend-graphql';

function owner() {
  return {
    userId: 'owned-user',
    authSessionId: 'owned-login',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(scope = owner()) {
  return {
    user: { id: scope.userId },
    authSessionId: scope.authSessionId,
    authGeneration: scope.generation,
    expires: '2026-11-14T00:00:00.000Z',
    browserSelection: scope,
  };
}
async function fixture() {
  let milliseconds = 0;
  let issued = 0;
  const leaseFetch = vi.fn<typeof fetch>(async () =>
    Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issued}`, usableForMs: 120_000, owner: owner() }),
  );
  const client = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => milliseconds,
    schedule: () => () => {},
  });
  client.acceptSession(session());
  const original = await client.acquire(owner());
  const scope = captureBrowserBackendRequestScope(original.token, client)!;
  const fetchGraphQL = vi.fn<typeof fetch>(async () => Response.json({ data: { viewer: { id: 'owned-user' } } }));
  const transport = createBrowserBackendGraphQLTransport({ client, scope, fetch: fetchGraphQL });
  const graphql = new GraphQLClient('https://api.owned.test/graphql', transport);
  return {
    client,
    scope,
    original,
    leaseFetch,
    fetchGraphQL,
    graphql,
    transport,
    advance(millisecondsElapsed: number) {
      milliseconds += millisecondsElapsed;
    },
  };
}
function deferred<ResponseType>() {
  let resolve!: (response: ResponseType) => void;
  const promise = new Promise<ResponseType>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const query = '{ viewer { id } }';

describe('actual graphql-request selected-browser transport', () => {
  it('attaches only a privately receipted current lease and validates the parsed result', async () => {
    const current = await fixture();
    await expect(current.graphql.request(query)).resolves.toEqual({ viewer: { id: 'owned-user' } });
    expect(new Headers(current.fetchGraphQL.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer bsbd1_OWNED1',
    );
    expect(current.leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('renews a long-lived client for its same owner without replaying its operation', async () => {
    const current = await fixture();
    current.advance(120_000);
    await current.graphql.request(query);
    expect(new Headers(current.fetchGraphQL.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer bsbd1_OWNED2',
    );
    expect(current.fetchGraphQL).toHaveBeenCalledTimes(1);
  });
  it.each(['UID', 'SID', 'generation', 'version'] as const)(
    'an earlier client cannot send as a newer %s',
    async (change) => {
      const current = await fixture();
      const next = owner();
      if (change === 'UID') next.userId = 'other-owned-user';
      if (change === 'SID') next.authSessionId = 'new-owned-login';
      if (change === 'generation') next.generation = 1;
      if (change === 'version') next.cursor.version = 2;
      current.client.acceptSession(session(next));
      await expect(current.graphql.request(query)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.fetchGraphQL).not.toHaveBeenCalled();
      expect(current.leaseFetch).toHaveBeenCalledTimes(1);
    },
  );
  it('discards response headers arriving after a newer sign-in', async () => {
    const current = await fixture();
    const pending = deferred<Response>();
    current.fetchGraphQL.mockImplementationOnce(async () => pending.promise);
    const request = current.graphql.request(query);
    await vi.waitFor(() => expect(current.fetchGraphQL).toHaveBeenCalledTimes(1));
    current.client.acceptSession(session({ ...owner(), userId: 'other-owned-user' }));
    pending.resolve(Response.json({ data: { viewer: { id: 'owned-user' } } }));
    await expect(request).rejects.toMatchObject({ status: 'superseded' });
  });
  it('discards an actual streamed GraphQL body completing after a newer account', async () => {
    const current = await fixture();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":{"viewer":'));
        finish = () => {
          controller.enqueue(new TextEncoder().encode('{"id":"owned-user"}}}'));
          controller.close();
        };
      },
    });
    current.fetchGraphQL.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const request = current.graphql.request(query);
    await vi.waitFor(() => expect(current.fetchGraphQL).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    current.client.acceptSession(session({ ...owner(), userId: 'other-owned-user' }));
    finish();
    await expect(request).rejects.toMatchObject({ status: 'superseded' });
  });
  it('pairs concurrent response receipts independently across lease renewal', async () => {
    const current = await fixture();
    const oldBody = deferred<Response>();
    current.fetchGraphQL.mockImplementationOnce(async () => oldBody.promise);
    const oldRequest = current.graphql.request(query);
    await vi.waitFor(() => expect(current.fetchGraphQL).toHaveBeenCalledTimes(1));
    current.advance(90_000);
    await expect(current.graphql.request(query)).resolves.toMatchObject({ viewer: { id: 'owned-user' } });
    current.advance(30_000);
    oldBody.resolve(Response.json({ data: { viewer: { id: 'owned-user' } } }));
    await expect(oldRequest).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetchGraphQL).toHaveBeenCalledTimes(2);
  });
  it('does not replay a mutation whose response outlives its presented lease', async () => {
    const current = await fixture();
    current.fetchGraphQL.mockImplementationOnce(async () => {
      current.advance(120_000);
      return Response.json({ data: { saved: true } });
    });
    await expect(current.graphql.request('mutation { saved }')).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetchGraphQL).toHaveBeenCalledTimes(1);
    expect(current.leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('unavailable renewal never downgrades an authenticated request to anonymous', async () => {
    const current = await fixture();
    current.advance(120_000);
    current.leaseFetch.mockResolvedValueOnce(Response.json({ status: 'unavailable' }, { status: 503 }));
    await expect(current.graphql.request(query)).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.fetchGraphQL).not.toHaveBeenCalled();
  });
  it('rejects unknown selected bearers, stale legacy headers and missing authenticated tokens', async () => {
    const current = await fixture();
    expect(() => captureBrowserBackendRequestScope('bsbd1_UNREGISTERED', current.client)).toThrow();
    expect(() => captureBrowserBackendRequestScope('old-legacy-bearer', current.client)).toThrow();
    expect(() => captureBrowserBackendRequestScope(null, current.client)).toThrow();
    expect(captureBrowserBackendRequestScope(undefined, current.client)).toBeNull();
  });
  it('invalid selected observation cannot downgrade a retired authenticated dispatch into anonymous', async () => {
    const current = await fixture();
    expect(() => current.client.acceptSession({ ...session(), browserSelection: undefined })).toThrow();
    expect(current.client.getSnapshot().owner).toBeNull();
    expect(() => captureBrowserBackendRequestScope(null, current.client)).toThrow();
    expect(() => captureBrowserBackendRequestScope(current.original.token, current.client)).toThrow();
    current.client.acceptSession(null); // Only successful central anonymity qualifies this path.
    expect(captureBrowserBackendRequestScope(null, current.client)).toBeNull();
  });
  it('a missing-marker legacy response after selected login remains unavailable rather than anonymous', async () => {
    const current = await fixture();
    expect(() => current.client.acceptSession({ user: { id: 'owned-user' } })).toThrow();
    expect(() => captureBrowserBackendRequestScope(null, current.client)).toThrow();
    current.client.acceptSession({});
    expect(captureBrowserBackendRequestScope(null, current.client)).toBeNull();
  });
});
