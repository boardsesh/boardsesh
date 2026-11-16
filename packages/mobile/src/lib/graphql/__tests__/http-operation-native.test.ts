import { GraphQLClient } from 'graphql-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ resolve: vi.fn(), offline: vi.fn() }));
vi.mock('../client', () => ({
  getHttpClient: () => state.resolve(),
  getOfflineSyncHttpClient: () => state.offline(),
}));
import { createHttpOperation } from '../http-operation';

let performFetch: ReturnType<typeof vi.fn<(...parameters: unknown[]) => Promise<Response>>>;
let client: GraphQLClient;
const document = '{ viewer { id } }';
beforeEach(() => {
  performFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ data: { viewer: { id: 'owned-native-A' } } }),
  );
  client = new GraphQLClient('https://backend.owned.test/graphql', { fetch: performFetch });
  state.resolve.mockReset().mockReturnValue(client);
  state.offline.mockReset().mockReturnValue(client);
});

describe('native-shaped original HTTP operation cancellation with the installed SDK', () => {
  it('refuses an already-aborted operation before resolving a client or sending', async () => {
    const controller = new AbortController();
    const reason = new Error('Owned operation cancellation');
    controller.abort(reason);
    const operation = createHttpOperation(undefined, { signal: controller.signal });
    await expect(operation.request(document)).rejects.toBe(reason);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(performFetch).not.toHaveBeenCalled();
    expect(() => operation.assertView()).toThrow(reason);
    expect(() => operation.assertDeliveries()).toThrow(reason);
  });

  it('refuses an already-aborted object-overload request without retiring its live operation', async () => {
    const controller = new AbortController();
    const reason = new Error('Owned request cancellation');
    controller.abort(reason);
    const operation = createHttpOperation(undefined);
    await expect(operation.request({ document, signal: controller.signal })).rejects.toBe(reason);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(performFetch).not.toHaveBeenCalled();
    expect(await operation.request(document)).toEqual({ viewer: { id: 'owned-native-A' } });
    expect(() => operation.assertView()).not.toThrow();
  });

  it.each(['operation', 'request', 'dispose'] as const)(
    'refuses %s cancellation after held abort-ignoring real SDK body decoding',
    async (change) => {
      let finish!: () => void;
      performFetch.mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":{"viewer":{"id":"owned-native-A"}}}'));
                finish = () => controller.close();
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const controller = new AbortController();
      const reason = new Error('Owned late cancellation');
      const operation = createHttpOperation(undefined, change === 'operation' ? { signal: controller.signal } : {});
      const pending = operation.request({
        document,
        ...(change === 'request' ? { signal: controller.signal } : {}),
      });
      const rejected =
        change === 'dispose'
          ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
          : expect(pending).rejects.toBe(reason);
      await vi.waitFor(() => expect(performFetch).toHaveBeenCalledTimes(1));
      if (change === 'dispose') operation.dispose();
      else controller.abort(reason);
      expect((performFetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
      finish();
      await rejected;
      expect(performFetch).toHaveBeenCalledTimes(1);
      if (change === 'request') expect(() => operation.assertView()).not.toThrow();
      else {
        expect(() => operation.assertView()).toThrow();
        expect(() => operation.assertDeliveries()).toThrow();
      }
    },
  );

  it('rechecks a cancellation caused while resolving the client before SDK send', async () => {
    const controller = new AbortController();
    const reason = new Error('Owned getter cancellation');
    state.resolve.mockImplementationOnce(() => {
      controller.abort(reason);
      return client;
    });
    const operation = createHttpOperation(undefined, { signal: controller.signal });
    await expect(operation.request(document)).rejects.toBe(reason);
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(performFetch).not.toHaveBeenCalled();
  });

  it('keeps native interactive/offline factories and both SDK overloads', async () => {
    const interactive = createHttpOperation(undefined);
    await interactive.request(document, { nativeVariable: 1 }, { 'X-Owned-Test': 'native' });
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.offline).not.toHaveBeenCalled();
    expect(new Headers((performFetch.mock.calls[0][1] as RequestInit).headers).get('X-Owned-Test')).toBe('native');
    const offline = createHttpOperation(undefined, { mode: 'offline' });
    await offline.request({ document, variables: { nativeVariable: 2 } });
    expect(state.offline).toHaveBeenCalledTimes(1);
    expect(JSON.parse((performFetch.mock.calls[1][1] as RequestInit).body as string).variables).toEqual({
      nativeVariable: 2,
    });
  });
});
