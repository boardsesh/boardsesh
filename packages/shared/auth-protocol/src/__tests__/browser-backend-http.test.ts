import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';
import {
  captureBrowserBackendHttpScope,
  createBrowserBackendHttpTransport,
  createBrowserBackendHttpTransportForView,
  isCurrentBrowserBackendHttpResult,
} from '../browser-backend-http';

const closeClients: (() => void)[] = [];
afterEach(() => closeClients.splice(0).forEach((close) => close()));
function fixture() {
  let clock = 0;
  let generation = 0;
  let sequence = 0;
  let owner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
  const reply = () => ({ status: 'admitted', token: `bsbd1_OWNED${++sequence}`, usableForMs: 120_000, owner });
  const leaseFetch = vi.fn<typeof fetch>(async () => Response.json(reply()));
  const client = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: '/owned-central-lease',
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
  client.acceptSession(session());
  closeClients.push(() => client.dispose());
  const graphFetch = vi.fn<typeof fetch>(async () => Response.json({ data: { preview: { id: 'owned-private' } } }));
  const create = () =>
    createBrowserBackendHttpTransportForView({
      client,
      fetch: graphFetch,
      captureGeneration: () => generation,
      isGenerationCurrent: (expected) => expected === generation,
    });
  return {
    client,
    leaseFetch,
    graphFetch,
    create,
    owner: () => owner,
    reply,
    setClock: (milliseconds: number) => (clock = milliseconds),
    retireGeneration: () => generation++,
    switchAccount(userId: string) {
      owner = { ...owner, userId };
      client.acceptSession(session());
    },
  };
}
async function decoded(transport: ReturnType<typeof createBrowserBackendHttpTransportForView>, init?: RequestInit) {
  const response = await transport.fetch('https://backend.example.test/graphql', init);
  const body = (await response.json()) as { data: { preview: { id: string } } };
  transport.admitResponse({ kind: 'result', headers: response.headers, data: body.data });
  return body.data;
}

describe('SDK-independent browser HTTP authority and delivery receipts', () => {
  it('lazily acquires a real first lease, attaches it once, and remembers only the original decoded objects', async () => {
    const current = fixture();
    const transport = current.create();
    expect(current.leaseFetch).not.toHaveBeenCalled();
    expect(current.graphFetch).not.toHaveBeenCalled();
    const result = await decoded(transport);
    expect(new Headers(current.graphFetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer bsbd1_OWNED1');
    expect(current.leaseFetch).toHaveBeenCalledTimes(1);
    expect(isCurrentBrowserBackendHttpResult(result, current.client)).toBe(true);
    expect(isCurrentBrowserBackendHttpResult(result.preview, current.client)).toBe(true);
    expect(isCurrentBrowserBackendHttpResult(structuredClone(result), current.client)).toBe(false);
    expect(isCurrentBrowserBackendHttpResult(structuredClone(result.preview), current.client)).toBe(false);
  });
  it.each(['B', 'ABA', 'generation'])(
    'construction-time %s drift refuses before first lease or actual send',
    async (change) => {
      const current = fixture();
      const transport = current.create();
      if (change === 'generation') current.retireGeneration();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      await expect(transport.fetch('/graphql', undefined)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.leaseFetch).not.toHaveBeenCalled();
      expect(current.graphFetch).not.toHaveBeenCalled();
    },
  );
  it('a pending first lease cannot initialize the old view after a newer central account', async () => {
    const current = fixture();
    let release!: (response: Response) => void;
    const firstReply = current.reply();
    current.leaseFetch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const transport = current.create();
    const pending = transport.fetch('/graphql', undefined);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    current.switchAccount('owned-B');
    release(Response.json(firstReply));
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    expect(current.graphFetch).not.toHaveBeenCalled();
  });
  it('a newer same-owner delivery does not extend an older result through its original expiry', async () => {
    const current = fixture();
    const transport = current.create();
    const first = await decoded(transport);
    current.setClock(90_000);
    const renewed = await decoded(transport);
    expect(current.leaseFetch).toHaveBeenCalledTimes(2);
    current.setClock(120_001);
    expect(transport.isCurrent()).toBe(true);
    expect(isCurrentBrowserBackendHttpResult(first, current.client)).toBe(false);
    expect(isCurrentBrowserBackendHttpResult(renewed, current.client)).toBe(true);
  });
  it('caller abort after decode retires that result while leaving the account available', async () => {
    const current = fixture();
    const transport = current.create();
    const controller = new AbortController();
    const result = await decoded(transport, { signal: controller.signal });
    controller.abort(new Error('Owned cancellation'));
    expect(isCurrentBrowserBackendHttpResult(result, current.client)).toBe(false);
    expect(transport.isCurrent()).toBe(true);
    expect(current.client.getSnapshot().owner?.userId).toBe('owned-A');
  });
  it('forged/copied header metadata cannot qualify a decoded result', async () => {
    const current = fixture();
    const transport = current.create();
    const response = await transport.fetch('/graphql', undefined);
    const body = (await response.json()) as { data: object };
    expect(() =>
      transport.admitResponse({ kind: 'result', headers: new Headers(response.headers), data: body.data }),
    ).toThrow();
    expect(isCurrentBrowserBackendHttpResult(body.data, current.client)).toBe(false);
    transport.admitResponse({ kind: 'result', headers: response.headers, data: body.data });
    expect(isCurrentBrowserBackendHttpResult(body.data, current.client)).toBe(true);
  });
  it('local disposal refuses old results and requests without invalidating another client for the account', async () => {
    const current = fixture();
    const old = current.create();
    const result = await decoded(old);
    old.dispose();
    old.dispose();
    expect(isCurrentBrowserBackendHttpResult(result, current.client)).toBe(false);
    await expect(old.fetch('/graphql', undefined)).rejects.toMatchObject({ status: 'superseded' });
    expect(current.graphFetch).toHaveBeenCalledTimes(1);
    const replacement = await decoded(current.create());
    expect(isCurrentBrowserBackendHttpResult(replacement, current.client)).toBe(true);
    expect(current.client.getSnapshot().owner?.userId).toBe('owned-A');
  });
  it('fixed branded-scope callers retain the WWW contract without importing an SDK', async () => {
    const current = fixture();
    const lease = await current.client.acquire(current.owner());
    const scope = captureBrowserBackendHttpScope(lease.token, current.client)!;
    const transport = createBrowserBackendHttpTransport({ client: current.client, scope, fetch: current.graphFetch });
    const result = await decoded(transport);
    expect(isCurrentBrowserBackendHttpResult(result, current.client)).toBe(true);
    expect(() => captureBrowserBackendHttpScope('bsbd1_FORGED', current.client)).toThrow();
    expect(() => captureBrowserBackendHttpScope(null, current.client)).toThrow();
    current.client.acceptSession({});
    expect(captureBrowserBackendHttpScope(null, current.client)).toBeNull();
  });
  it('error observations cannot manufacture result receipts or outlive their view', async () => {
    const current = fixture();
    const transport = current.create();
    expect(() => transport.admitResponse({ kind: 'error' })).not.toThrow();
    expect(isCurrentBrowserBackendHttpResult({ claimed: 'result' }, current.client)).toBe(false);
    current.switchAccount('owned-B');
    expect(() => transport.admitResponse({ kind: 'error' })).toThrow();
  });
  it('mutating constructor options cannot retarget the captured client or network transport', async () => {
    const original = fixture();
    const later = fixture();
    later.switchAccount('owned-B');
    const options = {
      client: original.client,
      fetch: original.graphFetch,
      captureGeneration: () => 0,
      isGenerationCurrent: () => true,
    };
    const transport = createBrowserBackendHttpTransportForView(options);
    options.client = later.client;
    options.fetch = later.graphFetch;
    options.isGenerationCurrent = () => false;
    const result = await decoded(transport);
    expect(original.graphFetch).toHaveBeenCalledTimes(1);
    expect(later.graphFetch).not.toHaveBeenCalled();
    expect(isCurrentBrowserBackendHttpResult(result, original.client)).toBe(true);
    expect(isCurrentBrowserBackendHttpResult(result, later.client)).toBe(false);
  });
});
