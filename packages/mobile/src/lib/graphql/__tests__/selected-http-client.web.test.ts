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
function fixture(timeout = 20_000) {
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
