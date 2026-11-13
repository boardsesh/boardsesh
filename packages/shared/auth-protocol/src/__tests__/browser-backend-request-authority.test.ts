import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';
import { createBrowserBackendRequestAuthority } from '../browser-backend-request-authority';

function fixture() {
  let clock = 0;
  let generation = 0;
  let issuance = 0;
  let owner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
  const session = () => ({
    user: { id: owner.userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  });
  const reply = () =>
    Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issuance}`, usableForMs: 120_000, owner });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply());
  const client = createBrowserBackendClient({
    ready: () => true,
    fetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => clock,
    schedule: () => () => {},
  });
  const options = {
    client,
    captureGeneration: () => generation,
    isGenerationCurrent: (expected: number) => expected === generation,
  };
  client.acceptSession(session());
  return {
    client,
    options,
    fetch,
    reply,
    create: () => createBrowserBackendRequestAuthority(options),
    advanceTo: (milliseconds: number) => (clock = milliseconds),
    retireView: () => generation++,
    switchAccount() {
      owner = { ...owner, userId: 'owned-B', cursor: { ...owner.cursor, version: 2 } };
      client.acceptSession(session());
    },
    restoreAccount() {
      owner = { ...owner, userId: 'owned-A', cursor: { ...owner.cursor, version: 1 } };
      client.acceptSession(session());
    },
  };
}

describe('fixed browser client request authority', () => {
  it('acquires actual proof lazily and accepts only its original result receipt', async () => {
    const current = fixture();
    const authority = current.create();
    expect(current.fetch).not.toHaveBeenCalled();
    expect(authority.isCurrent()).toBe(true);
    expect(() => authority.assertCurrent({ token: 'invented' })).toThrow();
    const lease = await authority.acquire();
    expect(current.fetch).toHaveBeenCalledTimes(1);
    expect(() => authority.assertCurrent(lease)).not.toThrow();
    expect(() => authority.assertCurrent({ ...lease })).toThrow();
    current.client.dispose();
  });
  it('cannot manufacture an owner or anonymous admission after local retirement', () => {
    const current = fixture();
    current.client.retire();
    expect(() => current.create()).toThrow();
    expect(current.client.isAnonymous()).toBe(false);
    expect(current.fetch).not.toHaveBeenCalled();
    current.client.dispose();
  });
  it('rejects a monotone view-generation change before any first acquisition', async () => {
    const current = fixture();
    const authority = current.create();
    current.retireView();
    await expect(authority.acquire()).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetch).not.toHaveBeenCalled();
    current.client.dispose();
  });
  it('cannot initialize an old client from A after B then A', async () => {
    const current = fixture();
    const authority = current.create();
    current.switchAccount();
    current.restoreAccount();
    expect(authority.isCurrent()).toBe(false);
    await expect(authority.acquire()).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetch).not.toHaveBeenCalled();
    current.client.dispose();
  });
  it('does not publish a first result after its view retires during the await', async () => {
    const current = fixture();
    const authority = current.create();
    let resolve!: (response: Response) => void;
    current.fetch.mockImplementationOnce(async () => new Promise<Response>((complete) => (resolve = complete)));
    const pending = authority.acquire();
    current.retireView();
    resolve(current.reply());
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    expect(current.client.getSnapshot().owner?.userId).toBe('owned-A');
    expect(current.client.isAnonymous()).toBe(false);
    current.client.dispose();
  });
  it('captures the generation witness before awaits rather than trusting replaced options', async () => {
    const current = fixture();
    const authority = current.create();
    let resolve!: (response: Response) => void;
    current.fetch.mockImplementationOnce(async () => new Promise<Response>((complete) => (resolve = complete)));
    const pending = authority.acquire();
    current.retireView();
    current.options.isGenerationCurrent = () => true;
    resolve(current.reply());
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    current.client.dispose();
  });
  it('local disposal fences pending initialization without retiring another client', async () => {
    const current = fixture();
    const authority = current.create();
    let resolve!: (response: Response) => void;
    current.fetch.mockImplementationOnce(async () => new Promise<Response>((complete) => (resolve = complete)));
    const pending = authority.acquire();
    authority.dispose();
    resolve(current.reply());
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
    const next = await current.create().acquire();
    expect(next.token).toBe('bsbd1_OWNED1');
    expect(current.fetch).toHaveBeenCalledTimes(1);
    current.client.dispose();
  });
  it('same-owner renewal never freshens an earlier original result receipt', async () => {
    const current = fixture();
    const authority = current.create();
    const old = await authority.acquire();
    current.advanceTo(120_000);
    const renewed = await authority.acquire();
    expect(renewed.token).toBe('bsbd1_OWNED2');
    expect(() => authority.assertCurrent(renewed)).not.toThrow();
    expect(() => authority.assertCurrent(old)).toThrow();
    current.client.dispose();
  });
  it('an obsolete client cannot invalidate another account or later ABA client', async () => {
    const current = fixture();
    const old = current.create();
    await old.acquire();
    current.switchAccount();
    const next = current.create();
    const nextLease = await next.acquire();
    old.invalidate();
    expect(() => next.assertCurrent(nextLease)).not.toThrow();
    current.restoreAccount();
    const restored = current.create();
    const restoredLease = await restored.acquire();
    old.invalidate();
    expect(() => restored.assertCurrent(restoredLease)).not.toThrow();
    current.client.dispose();
  });
  it('current invalidation retires only the observed revision and allows actual re-admission', async () => {
    const current = fixture();
    const old = current.create();
    const previous = await old.acquire();
    old.invalidate();
    expect(old.isCurrent()).toBe(false);
    expect(() => old.assertCurrent(previous)).toThrow();
    const next = await current.create().acquire();
    expect(next.token).toBe('bsbd1_OWNED2');
    expect(current.client.getSnapshot().owner?.userId).toBe('owned-A');
    current.client.dispose();
  });
  it('unavailable refresh retains only still-live proof and never asserts anonymity', async () => {
    const current = fixture();
    const authority = current.create();
    const old = await authority.acquire();
    current.fetch.mockImplementation(async () => Response.json({ status: 'unavailable' }, { status: 503 }));
    current.advanceTo(90_000);
    expect((await authority.acquire()).token).toBe(old.token);
    current.advanceTo(120_000);
    await expect(authority.acquire()).rejects.toMatchObject({ status: 'unavailable' });
    expect(() => authority.assertCurrent(old)).toThrow();
    expect(current.client.isAnonymous()).toBe(false);
    current.client.dispose();
  });
});
