import { ClientError } from 'graphql-request';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScopedHttpFixture } from './fixtures/scoped-http';

vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((dispose) => dispose()));
const document = 'mutation OwnedMutation { ownedMutation }';
const rejection = {
  data: { ownedMutation: { private: 'error-partial-data' } },
  errors: [{ message: 'Owned permanent rejection', extensions: { code: 'BAD_USER_INPUT' } }],
};
function fixture() {
  const current = createScopedHttpFixture();
  close.push(() => current.dispose());
  return current;
}
function heldError() {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(rejection)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
async function caught(execute: Promise<unknown>): Promise<unknown> {
  try {
    await execute;
    throw new Error('Expected owned rejection');
  } catch (error) {
    return error;
  }
}

describe('exact installed-SDK error delivery provenance', () => {
  it.each([200, 422])('admits the actual HTTP%s SDK error and refuses partial data success', async (status) => {
    const current = fixture();
    const response = Response.json(rejection, { status });
    current.performFetch.mockResolvedValueOnce(response);
    const operation = current.operations.capture();
    const error = await caught(operation.request(document));
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).response.headers).toBe(response.headers);
    expect(() => operation.assertErrorDeliveries(error)).not.toThrow();
    expect(() => operation.assertErrorDeliveries(new Error('Owned permanent rejection'))).toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
    expect(() => current.facade.assertCurrentResult(operation.scope, (error as ClientError).response.data)).toThrow();
  });

  it.each(['document', 'options'] as const)(
    'gives every %s invocation a distinct actual signal and exact thrown identity',
    async (overload) => {
      const current = fixture();
      const operation = current.operations.capture();
      const client = current.facade.getHttpClient(operation.scope);
      const observed: AbortSignal[] = [];
      let middlewareError: unknown;
      const originalMiddleware = client.requestConfig.responseMiddleware!;
      client.requestConfig.requestMiddleware = (request) => {
        observed.push(request.signal!);
        return request;
      };
      client.requestConfig.responseMiddleware = async (error, request) => {
        middlewareError = error;
        expect(request.signal).toBeUndefined();
        await originalMiddleware(error, request);
      };
      current.performFetch.mockImplementation(async () => Response.json(rejection));
      const first = await caught(
        overload === 'document' ? operation.request(document) : operation.request({ document }),
      );
      expect(first).toBe(middlewareError);
      const second = await caught(
        overload === 'document' ? operation.request(document) : operation.request({ document }),
      );
      expect(second).toBe(middlewareError);
      expect(first).not.toBe(second);
      expect(observed).toHaveLength(2);
      expect(observed[0]).not.toBe(observed[1]);
      expect(() => operation.assertErrorDeliveries(first)).not.toThrow();
      expect(() => operation.assertErrorDeliveries(second)).not.toThrow();
      expect(() => operation.assertDeliveries()).toThrow();
    },
  );

  it('refuses a requestMiddleware replacement signal despite an authentic decoded error', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    const client = current.facade.getHttpClient(operation.scope);
    const replacement = new AbortController().signal;
    client.requestConfig.requestMiddleware = (request) => ({ ...request, signal: replacement });
    current.performFetch.mockResolvedValueOnce(Response.json(rejection));
    const error = await caught(operation.request(document));
    expect(error).toBeInstanceOf(ClientError);
    expect(() => operation.assertErrorDeliveries(error)).toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
  });

  it.each(['same-operation', 'new-operation'] as const)(
    'refuses old error replay in a later %s reservation',
    async (kind) => {
      const current = fixture();
      const first = current.operations.capture();
      current.performFetch.mockResolvedValueOnce(Response.json(rejection));
      const original = await caught(first.request(document));
      expect(() => first.assertErrorDeliveries(original)).not.toThrow();
      const next = kind === 'same-operation' ? first : current.operations.capture();
      current.facade.getHttpClient(next.scope).requestConfig.requestMiddleware = () => {
        throw original;
      };
      expect(await caught(next.request(document))).toBe(original);
      expect(current.performFetch).toHaveBeenCalledOnce();
      expect(() => next.assertErrorDeliveries(original)).toThrow();
      if (kind === 'new-operation') expect(() => first.assertErrorDeliveries(original)).not.toThrow();
    },
  );

  it.each(['same-headers', 'copied-headers'] as const)('refuses a copied SDK error with %s', async (kind) => {
    const current = fixture();
    const originalOperation = current.operations.capture();
    current.performFetch.mockResolvedValueOnce(Response.json(rejection));
    const original = (await caught(originalOperation.request(document))) as ClientError;
    const copied = new ClientError(
      {
        ...original.response,
        ...(kind === 'copied-headers' ? { headers: new Headers(original.response.headers) } : {}),
      },
      original.request,
    );
    const next = current.operations.capture();
    current.facade.getHttpClient(next.scope).requestConfig.requestMiddleware = () => {
      throw copied;
    };
    expect(await caught(next.request(document))).toBe(copied);
    expect(() => next.assertErrorDeliveries(copied)).toThrow();
    expect(() => originalOperation.assertErrorDeliveries(original)).not.toThrow();
  });

  it.each(['fetch', 'parse'] as const)('preserves an unobserved %s error without minting authority', async (kind) => {
    const current = fixture();
    const operation = current.operations.capture();
    const failure = new Error('Owned unobserved failure');
    if (kind === 'fetch') current.performFetch.mockRejectedValueOnce(failure);
    else {
      current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
      current.facade.getHttpClient(operation.scope).requestConfig.jsonSerializer = {
        parse: () => {
          throw failure;
        },
        stringify: JSON.stringify,
      };
    }
    expect(await caught(operation.request(document))).toBe(failure);
    expect(() => operation.assertErrorDeliveries(failure)).toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
    await expect(operation.request(document)).rejects.toMatchObject({ status: 'unavailable' });
  });

  it.each(['B', 'ABA', 'abort', 'dispose'] as const)(
    'cannot mint an error receipt after held-body %s retirement',
    async (change) => {
      const current = fixture();
      const caller = new AbortController();
      const operation = current.operations.capture({ signal: caller.signal });
      const held = heldError();
      current.performFetch.mockResolvedValueOnce(held.response);
      const pending = caught(operation.request(document));
      await vi.waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      if (change === 'abort') caller.abort(new Error('Owned abort'));
      else if (change === 'dispose') operation.dispose();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      held.release();
      const error = await pending;
      expect(() => operation.assertErrorDeliveries(error)).toThrow();
      expect(() => operation.assertDeliveries()).toThrow();
      expect(current.performFetch).toHaveBeenCalledOnce();
    },
  );

  it.each(['B', 'ABA', 'expiry', 'dispose'] as const)(
    'keeps an admitted error bound to its original lease after %s',
    async (change) => {
      const current = fixture();
      const operation = current.operations.capture();
      current.performFetch.mockResolvedValueOnce(Response.json(rejection));
      const error = await caught(operation.request(document));
      const assertOriginal = () => operation.assertErrorDeliveries(error);
      expect(assertOriginal).not.toThrow();
      if (change === 'expiry') {
        current.clock(90_000);
        current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
        await current.operations.capture().request('{ viewer { id } }');
        current.clock(120_001);
      } else if (change === 'dispose') operation.dispose();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      expect(assertOriginal).toThrow();
      expect(() => operation.assertDeliveries()).toThrow();
    },
  );

  it('permits a real compatibility fallback only while every original success and error remains live', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    current.performFetch.mockResolvedValueOnce(Response.json(rejection));
    const error = await caught(operation.request(document));
    current.clock(90_000);
    current.performFetch.mockResolvedValueOnce(Response.json({ data: { ownedMutation: true } }));
    await operation.request(document);
    expect(() => operation.assertDeliveries()).not.toThrow();
    expect(() => operation.assertErrorDeliveries(error)).not.toThrow();
    current.clock(120_001);
    expect(() => operation.assertDeliveries()).toThrow();
    expect(() => operation.assertErrorDeliveries(error)).toThrow();
  });

  it('refuses the sixty-fifth mixed-outcome invocation before dispatch', async () => {
    const current = fixture();
    const operation = current.operations.capture();
    current.performFetch.mockImplementation(async () => Response.json(rejection));
    for (let index = 0; index < 32; index++) await caught(operation.request(document));
    current.performFetch.mockImplementation(async () => Response.json({ data: { ownedMutation: true } }));
    for (let index = 0; index < 32; index++) await operation.request(document);
    expect(() => operation.assertDeliveries()).not.toThrow();
    await expect(operation.request(document)).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.performFetch).toHaveBeenCalledTimes(64);
    operation.dispose();
    expect(() => operation.assertDeliveries()).toThrow();
  });
});
