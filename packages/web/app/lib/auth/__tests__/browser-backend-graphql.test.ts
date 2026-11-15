// @vitest-environment node
import { ClientError, GraphQLClient } from 'graphql-request';
import {
  captureBrowserBackendHttpError,
  captureBrowserBackendHttpResult,
} from '@boardsesh/auth-protocol/browser-backend-http';
import { createBrowserHttpOperation } from '@boardsesh/auth-protocol/browser-backend-http-operation';
import { createHttpOperationRequest } from '../../../../../mobile/src/lib/graphql/http-operation-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';
import {
  captureBrowserBackendRequestScope,
  createBrowserBackendGraphQLTransport,
  isCurrentBrowserBackendGraphQLResult,
} from '../browser-backend-graphql';

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
  it('rejects caller cancellation while an actual decoded response stream ignores abort', async () => {
    const current = await fixture();
    const controller = new AbortController();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"data":{"viewer":'));
        finish = () => {
          stream.enqueue(new TextEncoder().encode('{"id":"owned-user"}}}'));
          stream.close();
        };
      },
    });
    current.fetchGraphQL.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const pending = current.graphql.request({ document: query, signal: controller.signal });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new Error('Owned body cancelled'));
    finish();
    await expect(pending).rejects.toThrow('Owned body cancelled');
    expect(current.fetchGraphQL).toHaveBeenCalledOnce();
    current.client.dispose();
  });
  it('does not publish a body that ignored the original caller abort signal', async () => {
    const current = await fixture();
    const controller = new AbortController();
    current.fetchGraphQL.mockImplementationOnce(async () => {
      controller.abort(new Error('Owned caller cancelled'));
      return Response.json({ data: { viewer: { id: 'owned-user' } } });
    });
    await expect(current.graphql.request({ document: query, signal: controller.signal })).rejects.toThrow(
      'Owned caller cancelled',
    );
    expect(current.fetchGraphQL).toHaveBeenCalledOnce();
    current.client.dispose();
  });
  it('retires a decoded delivery if the caller aborts before its own consumer resumes', async () => {
    const current = await fixture();
    const controller = new AbortController();
    const result = await current.graphql.request({ document: query, signal: controller.signal });
    expect(isCurrentBrowserBackendGraphQLResult(result, current.client)).toBe(true);
    controller.abort();
    expect(isCurrentBrowserBackendGraphQLResult(result, current.client)).toBe(false);
    current.client.dispose();
  });
  it('receipts the actual decoded result and its direct operation object, but refuses copies', async () => {
    const current = await fixture();
    const result = await current.graphql.request<{ viewer: { id: string } }>(query);
    expect(isCurrentBrowserBackendGraphQLResult(result, current.client)).toBe(true);
    expect(isCurrentBrowserBackendGraphQLResult(result.viewer, current.client)).toBe(true);
    expect(isCurrentBrowserBackendGraphQLResult(structuredClone(result), current.client)).toBe(false);
    expect(isCurrentBrowserBackendGraphQLResult({ ...result.viewer }, current.client)).toBe(false);
    const other = await fixture();
    expect(isCurrentBrowserBackendGraphQLResult(result, other.client)).toBe(false);
    current.client.dispose();
    other.client.dispose();
  });
  it('keeps the original delivery deadline after a newer same-owner request renews its lease', async () => {
    const current = await fixture();
    const first = await current.graphql.request(query);
    current.advance(90_000);
    const renewed = await current.graphql.request(query);
    expect(isCurrentBrowserBackendGraphQLResult(first, current.client)).toBe(true);
    current.advance(30_000);
    expect(isCurrentBrowserBackendGraphQLResult(first, current.client)).toBe(false);
    expect(isCurrentBrowserBackendGraphQLResult(renewed, current.client)).toBe(true);
    current.client.dispose();
  });
  it.each(['invalidate', 'retire', 'dispose', 'ABA'] as const)(
    'refuses a delivery after the caller resumes across %s',
    async (change) => {
      const current = await fixture();
      const result = await current.graphql.request(query);
      if (change === 'invalidate') current.client.invalidate(current.scope);
      else if (change === 'ABA') {
        current.client.acceptSession(session({ ...owner(), userId: 'other-owner' }));
        current.client.acceptSession(session());
      } else current.client[change]();
      expect(isCurrentBrowserBackendGraphQLResult(result, current.client)).toBe(false);
      current.client.dispose();
    },
  );
  it('keeps legacy result behavior only until selected dispatch is observed', () => {
    const client = createBrowserBackendClient({
      ready: () => true,
      fetch: vi.fn<typeof fetch>(),
      endpoint: '/owned-lease',
      now: () => 0,
      schedule: () => () => {},
    });
    const legacy = { viewer: { id: 'legacy-user' } };
    expect(isCurrentBrowserBackendGraphQLResult(legacy, client)).toBe(true);
    client.acceptSession(session());
    expect(isCurrentBrowserBackendGraphQLResult(legacy, client)).toBe(false);
    client.dispose();
    expect(isCurrentBrowserBackendGraphQLResult(legacy, client)).toBe(false);
  });
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

function operationFor(current: Awaited<ReturnType<typeof fixture>>) {
  const signal = new AbortController().signal;
  const operation = createBrowserHttpOperation({
    signal,
    assertView: () => {
      if (!current.client.isCurrent(current.scope)) throw new Error('Owned WWW view retired');
    },
    captureDelivery: (result) => captureBrowserBackendHttpResult(result, current.client),
    captureErrorDelivery: (error, identity) => captureBrowserBackendHttpError(error, current.client, identity),
  });
  const request = createHttpOperationRequest({
    resolveClient: () => current.graphql,
    beginRequest: operation.beginRequest,
    signal,
  });
  return { ...operation, request };
}
async function originalError(execute: Promise<unknown>) {
  try {
    await execute;
    throw new Error('Expected owned rejection');
  } catch (error) {
    return error;
  }
}
describe('WWW actual SDK correlated error receipts', () => {
  it.each([200, 422])(
    'preserves exact HTTP%s errors and separate success authority across both overloads',
    async (status) => {
      const current = await fixture();
      try {
        const operation = operationFor(current);
        const requestSignals: AbortSignal[] = [];
        current.graphql.requestConfig.requestMiddleware = (request) => {
          requestSignals.push(request.signal!);
          return request;
        };
        const body = { data: { viewer: { private: 'partial-data' } }, errors: [{ message: 'Owned rejection' }] };
        current.fetchGraphQL.mockImplementation(async () => Response.json(body, { status }));
        const first = await originalError(operation.request(query));
        const second = await originalError(operation.request({ document: query }));
        expect(first).toBeInstanceOf(ClientError);
        expect(second).toBeInstanceOf(ClientError);
        expect(requestSignals[0]).not.toBe(requestSignals[1]);
        expect(() => operation.assertErrorDeliveries(first)).not.toThrow();
        expect(() => operation.assertErrorDeliveries(second)).not.toThrow();
        expect(() => operation.assertDeliveries()).toThrow();
        expect(captureBrowserBackendHttpResult((first as ClientError).response.data, current.client)).toBeNull();
        const original = () => operation.assertErrorDeliveries(first);
        current.advance(90_000);
        current.fetchGraphQL.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-user' } } }));
        await current.graphql.request(query);
        current.advance(30_001);
        expect(original).toThrow();
      } finally {
        current.client.dispose();
      }
    },
  );
  it('refuses a changed middleware signal and old exact-error replay', async () => {
    const current = await fixture();
    try {
      const first = operationFor(current);
      current.fetchGraphQL.mockResolvedValueOnce(Response.json({ errors: [{ message: 'Owned rejection' }] }));
      const original = await originalError(first.request(query));
      expect(() => first.assertErrorDeliveries(original)).not.toThrow();
      const replay = operationFor(current);
      current.graphql.requestConfig.requestMiddleware = () => {
        throw original;
      };
      expect(await originalError(replay.request(query))).toBe(original);
      expect(() => replay.assertErrorDeliveries(original)).toThrow();
      const changed = operationFor(current);
      current.graphql.requestConfig.requestMiddleware = (request) => ({
        ...request,
        signal: new AbortController().signal,
      });
      current.fetchGraphQL.mockResolvedValueOnce(
        Response.json({ errors: [{ message: 'Owned changed-signal rejection' }] }),
      );
      const error = await originalError(changed.request(query));
      expect(error).toBeInstanceOf(ClientError);
      expect(() => changed.assertErrorDeliveries(error)).toThrow();
    } finally {
      current.client.dispose();
    }
  });
  it.each(['B', 'ABA'] as const)('cannot mint a receipt for a held error body after %s', async (change) => {
    const current = await fixture();
    try {
      let release!: () => void;
      current.fetchGraphQL.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"errors":[{"message":"Owned rejection"}]}'));
              release = () => controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const operation = operationFor(current);
      const pending = originalError(operation.request(query));
      await vi.waitFor(() => expect(current.fetchGraphQL).toHaveBeenCalledOnce());
      current.client.acceptSession(session({ ...owner(), userId: 'owned-B' }));
      if (change === 'ABA') current.client.acceptSession(session());
      release();
      const error = await pending;
      expect(() => operation.assertErrorDeliveries(error)).toThrow();
      expect(() => operation.assertDeliveries()).toThrow();
    } finally {
      current.client.dispose();
    }
  });
});
