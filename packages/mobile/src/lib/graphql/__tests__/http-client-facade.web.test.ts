import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLClient } from 'graphql-request';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { WebAuthIdentity } from '../../auth-store.web';
import { createBrowserHttpClientFacade } from '../http-client-facade.web';
import { createBrowserHttpOperations } from '../http-operation-client.web';

vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
let namespace = 0;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});
function fixture(kind: 'selected' | 'legacy' | 'anonymous' = 'selected') {
  let clock = 0;
  let generation = 0;
  let required = kind !== 'legacy';
  let anonymous = kind === 'anonymous';
  let owner: BrowserBackendLeaseOwner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
  let identity: WebAuthIdentity | null =
    kind === 'anonymous'
      ? null
      : {
          userId: owner.userId,
          authSessionId: owner.authSessionId,
          ...(kind === 'selected' ? { browserSelection: owner } : {}),
        };
  let issued = 0;
  const leaseFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({
      status: 'admitted',
      token: `bsbd1_OWNED${++issued}`,
      usableForMs: 120_000,
      owner,
    }),
  );
  const backendClient = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: '/owned-lease',
    now: () => clock,
    schedule: () => () => {},
  });
  const accept = () =>
    backendClient.acceptSession({
      user: { id: owner.userId },
      authSessionId: owner.authSessionId,
      authGeneration: owner.generation,
      expires: '2099-01-01T00:00:00.000Z',
      browserSelection: owner,
    });
  if (kind === 'selected') accept();
  if (kind === 'anonymous') backendClient.acceptSession({});
  const rawFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ data: { viewer: { id: owner.userId } } }),
  );
  const legacyClient = new GraphQLClient('https://legacy.owned.test/graphql', { fetch: rawFetch });
  const legacyGet = vi.fn(() => legacyClient);
  const legacyReset = vi.fn();
  const options = {
    backendClient,
    captureGeneration: () => generation,
    isGenerationCurrent: (expected: number) => expected === generation,
    captureIdentity: () => identity,
    confirmedAnonymous: () => anonymous,
    required: () => required,
    namespace: () => `owned_facade_${++namespace}`,
    url: 'https://backend.owned.test/graphql',
    fetch: rawFetch,
    legacyFetch: rawFetch,
    timeoutMs: (mode: 'interactive' | 'offline') => (mode === 'offline' ? 30_000 : 20_000),
    clientIdentity: () => 'owned-expo-web',
    legacy: { get: legacyGet, reset: legacyReset },
  };
  const facade = createBrowserHttpClientFacade(options);
  const operations = createBrowserHttpOperations({
    captureScope: facade.captureRequestView,
    isCurrentView: facade.isCurrentView,
    captureResult: facade.captureResult,
    resolveClient: (scope, mode) =>
      mode === 'offline' ? facade.getOfflineSyncHttpClient(scope) : facade.getHttpClient(scope),
  });
  cleanup.push(() => {
    facade.dispose();
    backendClient.dispose();
  });
  return {
    facade,
    operations,
    backendClient,
    rawFetch,
    leaseFetch,
    legacyGet,
    legacyReset,
    legacyClient,
    clock: (next: number) => {
      clock = next;
    },
    nextGeneration: () => {
      generation += 1;
    },
    closeMode: () => {
      required = false;
    },
    switchAccount(userId: string) {
      owner = { ...owner, userId };
      accept();
      identity = { userId: owner.userId, authSessionId: owner.authSessionId, browserSelection: owner };
      anonymous = false;
    },
    recreate() {
      const replacement = createBrowserHttpClientFacade(options);
      cleanup.push(replacement.dispose);
      return replacement;
    },
    replaceLegacyFactory() {
      const replacement = new GraphQLClient('https://replacement.owned.test/graphql', { fetch: rawFetch });
      options.legacy.get = vi.fn(() => replacement);
      return replacement;
    },
  };
}
const document = '{ viewer { id } }';

describe('original operation with the installed GraphQL SDK', () => {
  it('captures before network work and preserves both SDK overloads, headers and variables', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    expect(current.leaseFetch).not.toHaveBeenCalled();
    expect(current.rawFetch).not.toHaveBeenCalled();
    expect(() => operation.assertDeliveries()).toThrow();
    const first = await operation.request<{ viewer: { id: string } }, { limit: number }>(
      document,
      { limit: 2 },
      { 'X-Owned-Test': 'positional' },
    );
    expect(first.viewer.id).toBe('owned-A');
    expect(JSON.parse((current.rawFetch.mock.calls[0][1] as RequestInit).body as string).variables).toEqual({
      limit: 2,
    });
    expect(new Headers((current.rawFetch.mock.calls[0][1] as RequestInit).headers).get('X-Owned-Test')).toBe(
      'positional',
    );
    const second = await operation.request<{ viewer: { id: string } }>({
      document,
      requestHeaders: { 'X-Owned-Test': 'object' },
    });
    expect(second.viewer.id).toBe('owned-A');
    expect(new Headers((current.rawFetch.mock.calls[1][1] as RequestInit).headers).get('X-Owned-Test')).toBe('object');
    operation.assertDeliveries();
  });

  it.each(['B', 'ABA', 'generation'] as const)(
    'a queued %s operation refuses before its first lease, getter or mutation send',
    async (change) => {
      const current = fixture();
      const operation = current.operations.capture();
      await Promise.resolve();
      if (change === 'generation') current.nextGeneration();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      await expect(operation.request('mutation OwnedAction { setOwnedPreference }')).rejects.toMatchObject({
        status: 'superseded',
      });
      expect(current.leaseFetch).not.toHaveBeenCalled();
      expect(current.rawFetch).not.toHaveBeenCalled();
      expect(current.legacyGet).not.toHaveBeenCalled();
    },
  );

  it('checks every original delivery instead of borrowing the newest same-owner lease', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    await operation.request(document);
    current.clock(90_000);
    await operation.request(document);
    const replacement = current.operations.capture();
    await replacement.request(document);
    current.clock(120_001);
    await Promise.resolve();
    expect(() => operation.assertView()).not.toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
    expect(() => replacement.assertDeliveries()).not.toThrow();
    expect(current.leaseFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps an after-own-await result tied to its operation after B and ABA', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    const original = await operation.request<{ viewer: { id: string } }>(document);
    current.switchAccount('owned-B');
    current.switchAccount('owned-A');
    const replacement = current.operations.capture();
    await replacement.request(document);
    await Promise.resolve();
    expect(original.viewer.id).toBe('owned-A');
    expect(() => operation.assertDeliveries()).toThrow();
    expect(() => replacement.assertDeliveries()).not.toThrow();
  });

  it('composes the object-overload caller abort through held real body decoding', async () => {
    const current = fixture();
    let finish!: () => void;
    current.rawFetch.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":{"viewer":{"id":"owned-A"}}}'));
              finish = () => controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const caller = new AbortController();
    const operation = current.operations.capture();
    const pending = operation.request({ document, signal: caller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(current.rawFetch).toHaveBeenCalledTimes(1));
    caller.abort();
    expect((current.rawFetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    finish();
    await rejected;
    expect(() => operation.assertDeliveries()).toThrow();
    expect(current.backendClient.getSnapshot().owner?.userId).toBe('owned-A');
  });

  it('local disposal refuses completed and pending work without retiring another operation', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    await operation.request(document);
    operation.dispose();
    await Promise.resolve();
    expect(() => operation.assertDeliveries()).toThrow();
    await expect(operation.request(document)).rejects.toMatchObject({ status: 'superseded' });
    const replacement = current.operations.capture();
    await replacement.request(document);
    expect(() => replacement.assertDeliveries()).not.toThrow();
    expect(current.backendClient.getSnapshot().owner?.userId).toBe('owned-A');
  });

  it('refuses a sixty-fifth request before sending it while sixty-four receipts remain valid', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    for (let index = 0; index < 64; index++) await operation.request(document);
    expect(() => operation.assertDeliveries()).not.toThrow();
    await expect(operation.request('mutation OwnedAction { setOwnedPreference }')).rejects.toMatchObject({
      status: 'unavailable',
    });
    expect(current.rawFetch).toHaveBeenCalledTimes(64);
  });

  it("does not turn an explicit unknown view into today's account", async () => {
    const current = fixture();
    const operation = current.operations.create('bshv1_unknown');
    await expect(operation.request(document)).rejects.toMatchObject({ status: 'superseded' });
    expect(current.leaseFetch).not.toHaveBeenCalled();
    expect(current.rawFetch).not.toHaveBeenCalled();
  });
});

describe('actual SDK clients located by original opaque browser views', () => {
  it('labels expose no credential and the actual request uses only its issued lease', async () => {
    const current = fixture();
    const label = current.facade.captureHandle();
    expect(label).toMatch(/^bshv1_owned_facade_/);
    expect(label).not.toContain('owned-A');
    expect(current.leaseFetch).not.toHaveBeenCalled();
    const result = await current.facade.getHttpClient(label).request<{ viewer: { id: string } }>(document);
    expect(current.leaseFetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers((current.rawFetch.mock.calls[0][1] as RequestInit | undefined)?.headers).get('Authorization'),
    ).toBe('Bearer bsbd1_OWNED1');
    expect(() => current.facade.assertCurrentResult(label, result)).not.toThrow();
    expect(() => current.facade.assertCurrentResult(label, result.viewer)).not.toThrow();
    expect(() => current.facade.assertCurrentResult(label, structuredClone(result))).toThrow();
    expect(current.facade.queryKey(['privateRoles'], label)).toEqual(['privateRoles', 'browser-view', label]);
    expect(JSON.stringify(current.facade.queryKey(['privateRoles'], label))).not.toContain('bsbd1_');
  });

  it.each(['B', 'ABA', 'generation'] as const)(
    'held %s intent cannot acquire or send for a later view',
    async (drift) => {
      const current = fixture();
      const label = current.facade.captureHandle();
      const client = current.facade.getHttpClient(label);
      if (drift === 'generation') current.nextGeneration();
      else {
        current.switchAccount('owned-B');
        if (drift === 'ABA') current.switchAccount('owned-A');
      }
      expect(() => current.facade.getHttpClient(label)).toThrow();
      await expect(client.request(document)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.leaseFetch).not.toHaveBeenCalled();
      expect(current.rawFetch).not.toHaveBeenCalled();
      expect(current.legacyGet).not.toHaveBeenCalled();
    },
  );

  it('same-owner renewal retains the label without extending an older decoded delivery', async () => {
    const current = fixture();
    const label = current.facade.captureHandle();
    const client = current.facade.getHttpClient(label);
    const first = await client.request(document);
    current.clock(90_000);
    const second = await client.request(document);
    expect(current.facade.captureHandle()).toBe(label);
    current.clock(120_000);
    expect(() => current.facade.assertCurrentResult(label, first)).toThrow();
    expect(() => current.facade.assertCurrentResult(label, second)).not.toThrow();
    expect(current.leaseFetch).toHaveBeenCalledTimes(2);
  });

  it('unknown, reset and previous-lifetime labels never fall back, even with the mode flag closed', async () => {
    const current = fixture();
    const label = current.facade.captureHandle();
    current.facade.reset();
    current.closeMode();
    expect(() => current.facade.getHttpClient(label)).toThrow();
    expect(() => current.facade.getHttpClient('bshv1_unknown')).toThrow();
    const replacement = current.recreate();
    expect(() => replacement.getHttpClient(label)).toThrow();
    const newLabel = replacement.captureHandle();
    expect(newLabel).not.toBe(label);
    expect(() => replacement.getHttpClient('bsbd1_NOT_A_QUERY_LABEL')).toThrow();
    expect(current.legacyGet).not.toHaveBeenCalled();
    expect(current.rawFetch).not.toHaveBeenCalled();
  });

  it('unknown required startup captured before an await cannot later adopt B', async () => {
    const current = fixture();
    current.backendClient.retire();
    const original = current.facade.captureRequestView();
    current.switchAccount('owned-B');
    expect(() => current.facade.getHttpClient(original)).toThrow();
    expect(current.rawFetch).not.toHaveBeenCalled();
    expect(current.leaseFetch).not.toHaveBeenCalled();
    const result = await current.facade
      .getHttpClient(current.facade.captureHandle())
      .request<{ viewer: { id: string } }>(document);
    expect(result.viewer.id).toBe('owned-B');
  });

  it('confirmed public requests strip supplied authentication without calling the legacy credential reader', async () => {
    const current = fixture('anonymous');
    const label = current.facade.captureHandle();
    await current.facade.getHttpClient(label).request(document, undefined, { Authorization: 'Bearer old-A' });
    expect(
      new Headers((current.rawFetch.mock.calls[0][1] as RequestInit | undefined)?.headers).has('Authorization'),
    ).toBe(false);
    expect(current.leaseFetch).not.toHaveBeenCalled();
    expect(current.legacyGet).not.toHaveBeenCalled();
  });

  it('unqualified explicit auth cannot choose the current account', () => {
    const current = fixture();
    expect(() => current.facade.getHttpClient(undefined)).toThrow();
    expect(() => current.facade.getHttpClient(null)).toThrow();
    expect(() => current.facade.getHttpClient(current.facade.captureRequestView(undefined))).toThrow();
    expect(current.leaseFetch).not.toHaveBeenCalled();
  });

  it('the installed SDK endpoint mutator cannot send an issued credential to another destination', async () => {
    const current = fixture();
    const client = current.facade.getHttpClient(current.facade.captureHandle());
    client.setEndpoint('https://different.owned.test/graphql');
    const [outcome] = await Promise.allSettled([client.request(document)]);
    expect({
      status: outcome.status,
      sent: current.rawFetch.mock.calls.length,
      issued: current.leaseFetch.mock.calls.length,
    }).toEqual({ status: 'rejected', sent: 0, issued: 0 });
  });

  it.each(['interactive', 'offline'] as const)(
    'retains the %s deadline during cold lease acquisition',
    async (mode) => {
      vi.useFakeTimers();
      const current = fixture();
      current.leaseFetch.mockImplementationOnce(() => new Promise(() => {}));
      const label = current.facade.captureHandle();
      const client =
        mode === 'offline' ? current.facade.getOfflineSyncHttpClient(label) : current.facade.getHttpClient(label);
      const pending = client.request(document);
      const timeoutMs = mode === 'offline' ? 30_000 : 20_000;
      const rejected = expect(pending).rejects.toMatchObject({ timeoutMs });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await rejected;
      expect(current.rawFetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('legacy default callers remain on their existing client until an actual selected observation', async () => {
    const current = fixture('legacy');
    expect(current.facade.getHttpClient()).toBe(current.legacyClient);
    const original = current.facade.captureHandle();
    const pinned = current.facade.getHttpClient(original);
    current.switchAccount('owned-B');
    await expect(pinned.request(document)).rejects.toMatchObject({ status: 'superseded' });
    expect(current.rawFetch).not.toHaveBeenCalled();
    expect(() => current.facade.getHttpClient()).not.toThrow();
    expect(current.legacyGet).toHaveBeenCalledTimes(1);
  });

  it('later mutation of the injected options cannot replace the captured client factory', () => {
    const current = fixture('legacy');
    const replacement = current.replaceLegacyFactory();
    expect(current.facade.getHttpClient()).toBe(current.legacyClient);
    expect(current.facade.getHttpClient()).not.toBe(replacement);
  });

  it('a throwing retirement observer cannot block another and old labels remain refused', () => {
    const current = fixture();
    const label = current.facade.captureHandle();
    current.facade.subscribe(() => {
      throw new Error('Owned disposed observer');
    });
    const second = vi.fn();
    current.facade.subscribe(second);
    current.facade.reset();
    expect(second).toHaveBeenCalledTimes(1);
    expect(current.facade.isCurrentView(label)).toBe(false);
    current.facade.dispose();
    expect(() => current.facade.getHttpClient(label)).toThrow();
  });
});
