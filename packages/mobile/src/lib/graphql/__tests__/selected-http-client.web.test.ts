import { createBrowserHttpOperations } from '../http-operation-client.web';
import { captureHttpOperationDispatchVeto, inheritHttpOperationDispatchVeto } from '../http-operation-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createSelectedBrowserHttpClient } from '../selected-http-client.web';
import { GraphQLEmptyResponseError } from '../request-gate';

vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
const connectivity = vi.hoisted(() => ({
  snapshot: { effectiveOffline: false, reason: null as string | null },
  report: vi.fn(),
}));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.snapshot,
  reportBackendOutcome: (outcome: unknown) => connectivity.report(outcome),
}));
const closeFixtures: (() => void)[] = [];
afterEach(() => {
  closeFixtures.splice(0).forEach((close) => close());
  connectivity.snapshot = { effectiveOffline: false, reason: null };
  connectivity.report.mockClear();
  vi.useRealTimers();
});
const query = '{ viewer { id } }';
type Result = { viewer: { id: string } };
function deferred<Contents>() {
  let resolve!: (contents: Contents) => void;
  const promise = new Promise<Contents>((complete) => (resolve = complete));
  return { promise, resolve };
}
function fixture(timeout: number | null = 20_000) {
  let clock = 0;
  let generation = 0;
  let sequence = 0;
  let owner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
  const reply = () =>
    Response.json({ status: 'admitted', token: `bsbd1_OWNED${++sequence}`, usableForMs: 120_000, owner });
  const leaseFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () => reply());
  const backendClient = createBrowserBackendClient({
    ready: () => true,
    endpoint: '/owned-canonical-lease',
    fetch: leaseFetch,
    now: () => clock,
    schedule: () => () => {},
  });
  const session = () => ({
    user: { id: owner.userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  });
  backendClient.acceptSession(session());
  const rawFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ data: { viewer: { id: owner.userId } } }),
  );
  const settings = {
    backendClient,
    url: 'https://owned-backend.example.test/graphql',
    fetch: rawFetch,
    captureGeneration: () => generation,
    isGenerationCurrent: (expected: number) => expected === generation,
    timeoutMs: () => timeout,
    clientIdentity: () => 'owned-expo-web/1.0.0 (web)',
  };
  const current = createSelectedBrowserHttpClient(settings);
  closeFixtures.push(() => {
    current.dispose();
    backendClient.dispose();
  });
  return {
    ...current,
    backendClient,
    rawFetch,
    leaseFetch,
    reply,
    clock: (milliseconds: number) => (clock = milliseconds),
    nextGeneration: () => generation++,
    replacement() {
      const entry = createSelectedBrowserHttpClient(settings);
      closeFixtures.push(entry.dispose);
      return entry;
    },
    switchAccount(userId: string) {
      owner = { ...owner, userId };
      backendClient.acceptSession(session());
    },
  };
}
describe('actual Expo browser fixed-view graphql-request client', () => {
  it('a cold client lazily acquires one actual lease and retains only actual decoded result objects', async () => {
    const current = fixture();
    expect(current.leaseFetch).not.toHaveBeenCalled();
    const result = await current.client.request<Result>(query);
    expect(current.leaseFetch).toHaveBeenCalledTimes(1);
    expect(current.rawFetch).toHaveBeenCalledTimes(1);
    const settings = current.rawFetch.mock.calls[0][1] as RequestInit | undefined;
    const headers = new Headers(settings?.headers);
    expect(headers.get('Authorization')).toBe('Bearer bsbd1_OWNED1');
    expect(headers.get('x-boardsesh-platform')).toBe('web');
    expect(headers.get('x-boardsesh-client')).toBe('owned-expo-web/1.0.0 (web)');
    expect(current.isCurrentResult(result)).toBe(true);
    expect(current.isCurrentResult(result.viewer)).toBe(true);
    expect(current.isCurrentResult(structuredClone(result))).toBe(false);
  });
  it.each(['B', 'ABA', 'generation'] as const)(
    'a held %s client refuses before its first credential or send',
    async (drift) => {
      const current = fixture();
      if (drift === 'generation') current.nextGeneration();
      else {
        current.switchAccount('owned-B');
        if (drift === 'ABA') current.switchAccount('owned-A');
      }
      await expect(current.client.request(query)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.leaseFetch).not.toHaveBeenCalled();
      expect(current.rawFetch).not.toHaveBeenCalled();
      expect(connectivity.report).not.toHaveBeenCalled();
    },
  );
  it('offline fail-fast occurs before cold lease acquisition and preserves connectivity classification', async () => {
    const current = fixture();
    connectivity.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };
    await expect(current.client.request(query)).rejects.toMatchObject({ name: 'BackendUnavailableError' });
    expect(current.leaseFetch).not.toHaveBeenCalled();
    expect(current.rawFetch).not.toHaveBeenCalled();
    expect(connectivity.report).not.toHaveBeenCalled();
  });
  it.each([20_000, 30_000])(
    'the %ims deadline includes a held cold credential request without a send',
    async (timeout) => {
      vi.useFakeTimers();
      const current = fixture(timeout);
      const held = deferred<Response>();
      const original = current.reply();
      current.leaseFetch.mockReturnValueOnce(held.promise);
      const pending = current.client.request(query);
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError', timeoutMs: timeout });
      await vi.advanceTimersByTimeAsync(timeout);
      await rejection;
      held.resolve(original);
      await vi.advanceTimersByTimeAsync(0);
      expect(current.rawFetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('the existing malformed successful-body classification remains intact', async () => {
    const current = fixture();
    current.rawFetch.mockResolvedValueOnce(new Response(''));
    await expect(current.client.request(query)).rejects.toBeInstanceOf(GraphQLEmptyResponseError);
    expect(connectivity.report).toHaveBeenCalledWith({ kind: 'failure', error: expect.any(GraphQLEmptyResponseError) });
  });
  it('caller abort still refuses real SDK decode after the inspection gate has removed its temporary listeners', async () => {
    const current = fixture();
    const controller = new AbortController();
    const held = deferred<void>();
    let decoding = false;
    const response = Response.json({ data: { viewer: { id: 'owned-A' } } });
    const originalText = response.text.bind(response);
    vi.spyOn(response, 'text').mockImplementationOnce(async () => {
      decoding = true;
      await held.promise;
      return originalText();
    });
    current.rawFetch.mockResolvedValueOnce(response);
    const pending = current.client.request({ document: query, signal: controller.signal });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(decoding).toBe(true));
    controller.abort(new Error('Owned post-inspection cancellation'));
    held.resolve();
    await expect(pending).rejects.toThrow('Owned post-inspection cancellation');
    expect(current.isCurrent()).toBe(true);
    expect(current.rawFetch).toHaveBeenCalledTimes(1);
  });
  it('original caller cancellation after decode retires only that delivery through caller-owned awaits', async () => {
    const current = fixture();
    const controller = new AbortController();
    const result = await current.client.request<Result>({ document: query, signal: controller.signal });
    expect(current.isCurrentResult(result)).toBe(true);
    controller.abort();
    expect(current.isCurrentResult(result)).toBe(false);
    expect(current.isCurrent()).toBe(true);
  });
  it('a newer same-owner lease cannot extend the older actual decoded delivery', async () => {
    const current = fixture();
    const first = await current.client.request<Result>(query);
    current.clock(90_000);
    const second = await current.client.request<Result>(query);
    current.clock(120_001);
    expect(current.isCurrentResult(first)).toBe(false);
    expect(current.isCurrentResult(second)).toBe(true);
  });
  it('a confirmed live 401 retires only the original scope and sends the mutation once', async () => {
    const current = fixture();
    current.rawFetch.mockResolvedValueOnce(Response.json({ errors: [{ message: 'Denied' }] }, { status: 401 }));
    const revision = current.backendClient.getSnapshot().revision;
    await expect(current.client.request('mutation { changeOwnedThing }')).rejects.toMatchObject({ status: 'denied' });
    expect(current.rawFetch).toHaveBeenCalledTimes(1);
    expect(current.backendClient.getSnapshot().revision).toBe(revision + 1);
    expect(current.backendClient.getSnapshot().owner?.userId).toBe('owned-A');
    expect(connectivity.report.mock.calls).toEqual([[{ kind: 'success' }]]);
  });
  it('a private source-issuer refusal with no GraphQL response supplies no reachability sample', async () => {
    const current = fixture();
    current.leaseFetch.mockResolvedValueOnce(Response.json({ status: 'denied' }, { status: 401 }));
    await expect(current.client.request(query)).rejects.toMatchObject({ status: 'denied' });
    expect(current.rawFetch).not.toHaveBeenCalled();
    expect(connectivity.report).not.toHaveBeenCalled();
  });
  it('an actual backend 503 keeps its established single failure sample', async () => {
    const current = fixture();
    current.rawFetch.mockResolvedValueOnce(Response.json({ errors: [{ message: 'Unavailable' }] }, { status: 503 }));
    await expect(current.client.request(query)).rejects.toMatchObject({ response: { status: 503 } });
    expect(current.rawFetch).toHaveBeenCalledTimes(1);
    expect(connectivity.report.mock.calls).toEqual([[{ kind: 'failure', status: 503 }]]);
  });
  it('an unclosed actual 401 body is cancelled without delaying or double-counting the refusal', async () => {
    const current = fixture();
    const cancel = vi.fn();
    current.rawFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }));
    await expect(current.client.request(query)).rejects.toMatchObject({ status: 'denied' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(connectivity.report.mock.calls).toEqual([[{ kind: 'success' }]]);
    expect(current.rawFetch).toHaveBeenCalledTimes(1);
  });
  it('a cancelled actual request cannot report its late 401 as a backend failure or a reachable response', async () => {
    const current = fixture();
    const controller = new AbortController();
    const held = deferred<Response>();
    const cancel = vi.fn();
    current.rawFetch.mockReturnValueOnce(held.promise);
    const pending = current.client.request({ document: query, signal: controller.signal });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(current.rawFetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Owned request cancelled'));
    await expect(pending).rejects.toThrow('Owned request cancelled');
    held.resolve(new Response(new ReadableStream({ cancel }), { status: 401 }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(connectivity.report).not.toHaveBeenCalled();
  });
  it('local disposal aborts an actual held request and refuses later decoded publication', async () => {
    const current = fixture();
    const held = deferred<Response>();
    current.rawFetch.mockReturnValueOnce(held.promise);
    const pending = current.client.request(query);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(current.rawFetch).toHaveBeenCalledTimes(1));
    current.dispose();
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    held.resolve(Response.json({ data: { viewer: { id: 'owned-A' } } }));
    await Promise.resolve();
    expect(current.isCurrent()).toBe(false);
    expect(current.backendClient.getSnapshot().owner?.userId).toBe('owned-A');
    expect(connectivity.report).not.toHaveBeenCalled();
  });
  it('a retired client cannot adopt the current result of a replacement client for the same account', async () => {
    const current = fixture();
    const first = await current.client.request<Result>(query);
    current.dispose();
    const replacement = current.replacement();
    const later = await replacement.client.request<Result>(query);
    expect(current.isCurrentResult(first)).toBe(false);
    expect(current.isCurrentResult(later)).toBe(false);
    expect(replacement.isCurrentResult(later)).toBe(true);
  });
});

describe('actual selected error capture bridge', () => {
  it('binds the exact SDK error to its original signal before gate composition', async () => {
    const current = fixture();
    const signal = new AbortController().signal;
    current.rawFetch.mockResolvedValueOnce(Response.json({ errors: [{ message: 'Owned rejection' }] }));
    let error: unknown;
    try {
      await current.client.request({ document: query, signal });
    } catch (caught) {
      error = caught;
    }
    const original = current.captureErrorDelivery(error, signal)!;
    expect(original).not.toBeNull();
    expect(original).not.toThrow();
    expect(current.captureErrorDelivery(error, new AbortController().signal)).toBeNull();
    expect(current.captureResult(error)).toBeNull();
    current.dispose();
    expect(original).toThrow();
  });
});

// The existing fixture owns the real backend authority, selected transport,
// graphql-request decoder and original success/error delivery captures.
// This adapter is the production operation factory with those actual ports.
function operationFixture(current: ReturnType<typeof fixture>) {
  return createBrowserHttpOperations({
    captureScope: () => undefined,
    isCurrentView: () => current.isCurrent(),
    captureResult: (_scope, result) => current.captureResult(result),
    captureErrorDelivery: (_scope, error, identity) => current.captureErrorDelivery(error, identity),
    resolveClient: () => current.client,
  });
}
function packetQueries(current: ReturnType<typeof fixture>) {
  return current.rawFetch.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).query as string,
  );
}
describe('actual operation dispatch veto across selected signal compositions', () => {
  it.each([null, 20_000])(
    'refuses an expired actual E1 after held acquire while independent E2 completes (%s deadline)',
    async (timeout) => {
      const current = fixture(timeout);
      const operations = operationFixture(current);
      const first = operations.capture();
      await first.request<Result>('query OwnedFirst { viewer { id } }');
      first.assertDeliveries();
      current.clock(100_000);
      const held = deferred<Response>();
      current.leaseFetch.mockReturnValueOnce(held.promise);
      const refresh = operations.capture({ assertDispatch: first.assertDeliveries });
      const pending = refresh.request<Result>('query OwnedRefresh { viewer { id } }');
      const refusal = expect(pending).rejects.toMatchObject({ status: 'superseded' });
      await vi.waitFor(() => expect(current.leaseFetch).toHaveBeenCalledTimes(2));
      const independent = operations.capture();
      const fresh = independent.request<Result>('query OwnedIndependent { viewer { id } }');
      // E2 is decoded/admitted at the new monotonic instant. E1's original
      // delivery expires; no timer/sampler manufactures a cancellation here.
      current.clock(130_000);
      held.resolve(current.reply());
      await fresh;
      independent.assertDeliveries();
      await refusal;
      expect(() => first.assertDeliveries()).toThrow();
      expect(packetQueries(current).filter((document) => document.includes('OwnedRefresh'))).toEqual([]);
      expect(packetQueries(current).filter((document) => document.includes('OwnedIndependent'))).toHaveLength(1);
      expect(connectivity.report.mock.calls.some(([outcome]) => (outcome as { kind: string }).kind === 'failure')).toBe(
        false,
      );
      first.dispose();
      refresh.dispose();
      independent.dispose();
    },
  );
  it('sends the same held acquisition while the actual original E1 remains live', async () => {
    const current = fixture();
    const operations = operationFixture(current);
    const first = operations.capture();
    await first.request<Result>('query OwnedFirst { viewer { id } }');
    current.clock(100_000);
    const held = deferred<Response>();
    current.leaseFetch.mockReturnValueOnce(held.promise);
    const refresh = operations.capture({ assertDispatch: first.assertDeliveries });
    const pending = refresh.request<Result>('query OwnedRefresh { viewer { id } }');
    await vi.waitFor(() => expect(current.leaseFetch).toHaveBeenCalledTimes(2));
    current.clock(110_000);
    held.resolve(current.reply());
    await pending;
    first.assertDeliveries();
    refresh.assertDeliveries();
    expect(packetQueries(current).filter((document) => document.includes('OwnedRefresh'))).toHaveLength(1);
    first.dispose();
    refresh.dispose();
  });
  it.each(['positional', 'options'] as const)(
    'binds a unique real SDK identity and keeps closed primary/final aliases for %s overload',
    async (overload) => {
      const current = fixture();
      const operations = operationFixture(current);
      const first = operations.capture();
      await first.request<Result>(query);
      let primary: AbortSignal | null | undefined;
      current.client.requestConfig.requestMiddleware = (request) => {
        primary = request.signal;
        return request;
      };
      const original = vi.fn(() => first.assertDeliveries());
      const operation = operations.capture({ assertDispatch: original });
      if (overload === 'options')
        await operation.request<Result>({ document: query, signal: new AbortController().signal });
      else await operation.request<Result>(query);
      operation.assertDeliveries();
      const finalCall = current.rawFetch.mock.calls.at(-1);
      expect(finalCall).toBeDefined();
      const final = (finalCall![1] as RequestInit).signal;
      expect(primary).toBeTruthy();
      expect(final).toBeTruthy();
      expect(final).not.toBe(primary);
      const primaryVeto = captureHttpOperationDispatchVeto(primary);
      const finalVeto = captureHttpOperationDispatchVeto(final);
      expect(primaryVeto).toBeTypeOf('function');
      expect(finalVeto).toBe(primaryVeto);
      const calls = original.mock.calls.length;
      expect(() => primaryVeto!()).toThrow();
      expect(() => finalVeto!()).toThrow();
      expect(original).toHaveBeenCalledTimes(calls);
      first.dispose();
      operation.dispose();
    },
  );
});

it('keeps actual parallel invocation vetoes isolated even with one caller signal and rejects alias collisions', async () => {
  const current = fixture();
  const operations = operationFixture(current);
  const original = operations.capture();
  await original.request<Result>('query OwnedOriginal { viewer { id } }');
  const caller = new AbortController();
  const firstBody = deferred<Response>();
  const secondBody = deferred<Response>();
  const signals: AbortSignal[] = [];
  current.client.requestConfig.requestMiddleware = (request) => {
    signals.push(request.signal!);
    return request;
  };
  current.rawFetch.mockReturnValueOnce(firstBody.promise).mockReturnValueOnce(secondBody.promise);
  const first = operations.capture({ assertDispatch: original.assertDeliveries });
  const second = operations.capture({ assertDispatch: original.assertDeliveries });
  const one = first.request<Result>({ document: 'query OwnedParallelOne { viewer { id } }', signal: caller.signal });
  const two = second.request<Result>({ document: 'query OwnedParallelTwo { viewer { id } }', signal: caller.signal });
  await vi.waitFor(() => expect(current.rawFetch).toHaveBeenCalledTimes(3));
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
  const alias = new AbortController().signal;
  inheritHttpOperationDispatchVeto(signals[0], alias);
  expect(() => inheritHttpOperationDispatchVeto(signals[1], alias)).toThrow();
  firstBody.resolve(Response.json({ data: { viewer: { id: 'owned-A' } } }));
  await one;
  const firstVeto = captureHttpOperationDispatchVeto(signals[0])!;
  const secondVeto = captureHttpOperationDispatchVeto(signals[1])!;
  expect(firstVeto).toThrow();
  expect(secondVeto).not.toThrow();
  secondBody.resolve(Response.json({ data: { viewer: { id: 'owned-A' } } }));
  await two;
  expect(secondVeto).toThrow();
  first.assertDeliveries();
  second.assertDeliveries();
  expect(packetQueries(current).filter((document) => document.includes('OwnedParallel'))).toHaveLength(2);
  original.dispose();
  first.dispose();
  second.dispose();
});
it('closes an opted-in actual timed-out acquisition before its late lease can reach physical fetch', async () => {
  vi.useFakeTimers();
  const current = fixture(20_000);
  const operations = operationFixture(current);
  const original = operations.capture();
  await original.request<Result>('query OwnedOriginal { viewer { id } }');
  current.clock(100_000);
  const held = deferred<Response>();
  current.leaseFetch.mockReturnValueOnce(held.promise);
  let primary: AbortSignal | null | undefined;
  current.client.requestConfig.requestMiddleware = (request) => {
    primary = request.signal;
    return request;
  };
  const originalAssertion = vi.fn(original.assertDeliveries);
  const refresh = operations.capture({ assertDispatch: originalAssertion });
  const pending = refresh.request<Result>('query OwnedTimeoutRefresh { viewer { id } }');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', timeoutMs: 20_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(current.leaseFetch).toHaveBeenCalledTimes(2);
  const veto = captureHttpOperationDispatchVeto(primary)!;
  expect(veto).not.toThrow();
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  const calls = originalAssertion.mock.calls.length;
  expect(veto).toThrow();
  expect(originalAssertion).toHaveBeenCalledTimes(calls);
  held.resolve(current.reply());
  await vi.advanceTimersByTimeAsync(0);
  expect(packetQueries(current).filter((document) => document.includes('OwnedTimeoutRefresh'))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(originalAssertion).toHaveBeenCalledTimes(calls);
  original.dispose();
  refresh.dispose();
});
it('copies the optional veto at actual operation creation without reading a later caller replacement', async () => {
  const current = fixture();
  const operations = operationFixture(current);
  const original = operations.capture();
  await original.request<Result>('query OwnedOriginal { viewer { id } }');
  const captured = vi.fn(original.assertDeliveries);
  const later = vi.fn(() => {
    throw new Error('Unexpected caller replacement');
  });
  const options = { assertDispatch: captured };
  const refresh = operations.capture(options);
  options.assertDispatch = later;
  await refresh.request<Result>('query OwnedCopiedVeto { viewer { id } }');
  refresh.assertDeliveries();
  expect(captured).toHaveBeenCalled();
  expect(later).not.toHaveBeenCalled();
  expect(packetQueries(current).filter((document) => document.includes('OwnedCopiedVeto'))).toHaveLength(1);
  original.dispose();
  refresh.dispose();
});
