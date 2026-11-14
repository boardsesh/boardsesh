import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendLeaseManager, type BrowserBackendLeaseOwner } from '../browser-backend-lease';
import { createBrowserBackendLeaseConsumer } from '../browser-backend-consumer';

const originalOwner = (): BrowserBackendLeaseOwner => ({
  userId: 'owned-user',
  authSessionId: 'owned-login',
  generation: 2,
  cursor: { bindingId: 'a'.repeat(64), version: 3 },
});
function deferred() {
  let resolve!: (reply: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function fixture() {
  let time = 0;
  let issued = 0;
  const fetchLease = vi.fn(async (owner: BrowserBackendLeaseOwner): Promise<unknown> => ({
    status: 'admitted',
    token: `bsbd1_OWNED${++issued}`,
    usableForMs: 120_000,
    owner,
  }));
  const manager = createBrowserBackendLeaseManager({
    now: () => time,
    fetchLease,
    schedule: () => () => {},
  });
  const consumer = createBrowserBackendLeaseConsumer(manager);
  manager.setOwner(originalOwner());
  return {
    manager,
    consumer,
    fetchLease,
    advance(milliseconds: number) {
      time += milliseconds;
    },
    async capture() {
      const lease = await manager.acquire(originalOwner());
      if (lease.status !== 'admitted') throw new Error('Owned lease fixture failed');
      expect(consumer.remember(lease)).toBe(true);
      const scope = consumer.capture(lease.token)!;
      expect(scope).not.toBeNull();
      return { lease, scope };
    },
  };
}

describe('selected browser client intent scopes', () => {
  it('requires an original current receipt, not a raw bearer or copied result', async () => {
    const current = fixture();
    const lease = await current.manager.acquire(originalOwner());
    expect(current.consumer.capture('bsbd1_OWNED1')).toBeNull();
    expect(current.consumer.remember({ ...lease })).toBe(false);
    expect(current.consumer.remember(lease)).toBe(true);
    expect(current.consumer.capture('bsbd1_OWNED1')).not.toBeNull();
    expect(current.consumer.isCurrent({})).toBe(false);
    expect(() => current.consumer.assertCurrent({}, lease)).toThrow();
  });
  it.each(['UID', 'SID', 'generation', 'binding', 'version'] as const)(
    'an earlier %s scope cannot acquire the newer account/login credential',
    async (change) => {
      const current = fixture();
      const { lease, scope } = await current.capture();
      const next = originalOwner();
      if (change === 'UID') next.userId = 'other-owned-user';
      if (change === 'SID') next.authSessionId = 'same-user-new-login';
      if (change === 'generation') next.generation += 1;
      if (change === 'binding') next.cursor.bindingId = 'b'.repeat(64);
      if (change === 'version') next.cursor.version += 1;
      current.manager.setOwner(next);
      const replacement = await current.manager.acquire(next);
      expect(current.consumer.remember(replacement)).toBe(true);
      expect(current.consumer.capture(lease.token)).toBeNull();
      await expect(current.consumer.acquire(scope)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.fetchLease).toHaveBeenCalledTimes(2);
      expect(() => current.consumer.assertCurrent(scope, lease)).toThrow();
    },
  );
  it('does not revive an A client after A to B to A, even with identical metadata', async () => {
    const current = fixture();
    const { scope } = await current.capture();
    current.manager.setOwner({ ...originalOwner(), userId: 'other-owned-user' });
    current.manager.setOwner(originalOwner());
    const replacement = await current.capture();
    expect(current.consumer.isCurrent(replacement.scope)).toBe(true);
    expect(current.consumer.isCurrent(scope)).toBe(false);
    await expect(current.consumer.acquire(scope)).rejects.toMatchObject({ status: 'superseded' });
  });
  it('renews the captured same-owner client after its original lease expires', async () => {
    const current = fixture();
    const { lease, scope } = await current.capture();
    current.advance(120_000);
    expect(current.consumer.capture(lease.token)).toBeNull();
    expect(() => current.consumer.assertCurrent(scope, lease)).toThrow();
    const renewed = await current.consumer.acquire(scope);
    expect(renewed.token).toBe('bsbd1_OWNED2');
    expect(current.consumer.isCurrent(scope)).toBe(true);
    expect(() => current.consumer.assertCurrent(scope, renewed)).not.toThrow();
  });
  it('rejects an already-cached positive after the await crosses an account switch', async () => {
    const current = fixture();
    const { scope } = await current.capture();
    const cached = current.consumer.acquire(scope);
    current.manager.setOwner({ ...originalOwner(), userId: 'other-owned-user' });
    await expect(cached).rejects.toMatchObject({ status: 'superseded' });
  });
  it('rejects delayed renewal after a new login and never retries as that login', async () => {
    const current = fixture();
    const { scope } = await current.capture();
    current.advance(111_000);
    const pending = deferred();
    current.fetchLease.mockImplementationOnce(async () => pending.promise);
    const renewed = current.consumer.acquire(scope);
    const next = { ...originalOwner(), authSessionId: 'same-user-new-login' };
    current.manager.setOwner(next);
    pending.resolve({ status: 'admitted', token: 'bsbd1_LATE', usableForMs: 120_000, owner: originalOwner() });
    await expect(renewed).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetchLease).toHaveBeenCalledTimes(2);
  });
  it('rejects data publication after a response body awaits across a switch', async () => {
    const current = fixture();
    const { scope } = await current.capture();
    const lease = await current.consumer.acquire(scope);
    current.consumer.assertCurrent(scope, lease); // Before the request.
    const body = deferred();
    const publish = vi.fn();
    const operation = (async () => {
      const result = await body.promise;
      current.consumer.assertCurrent(scope, lease);
      publish(result);
    })();
    current.manager.setOwner({ ...originalOwner(), userId: 'other-owned-user' });
    body.resolve({ privateOwnedResult: true });
    await expect(operation).rejects.toMatchObject({ status: 'superseded' });
    expect(publish).not.toHaveBeenCalled();
  });
  it('also refuses publication when only the presented lease expired during a long request', async () => {
    const current = fixture();
    const { scope, lease } = await current.capture();
    current.advance(120_000);
    expect(current.consumer.isCurrent(scope)).toBe(true);
    expect(() => current.consumer.assertCurrent(scope, lease)).toThrow();
    expect(current.fetchLease).toHaveBeenCalledTimes(1); // Never replay a mutation.
  });
  it.each(['denied', 'conflict'] as const)(
    'a %s refresh retires every old scope and cached receipt',
    async (status) => {
      const current = fixture();
      const { scope, lease } = await current.capture();
      current.advance(111_000);
      current.fetchLease.mockResolvedValueOnce({ status });
      // A terminal reply changes the producer revision, so the consumer refuses
      // even before interpreting a reply that belonged to the retired revision.
      await expect(current.consumer.acquire(scope)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.consumer.isCurrent(scope)).toBe(false);
      expect(current.consumer.capture(lease.token)).toBeNull();
    },
  );
  it('uncertainty retains only the original same-owner unexpired receipt', async () => {
    const current = fixture();
    const { scope, lease } = await current.capture();
    current.advance(111_000);
    current.fetchLease.mockResolvedValue({ status: 'unavailable' });
    const limited = await current.consumer.acquire(scope);
    expect(limited.token).toBe(lease.token);
    expect(limited.usableForMs).toBe(9000);
    current.advance(9000);
    await expect(current.consumer.acquire(scope)).rejects.toMatchObject({ status: 'unavailable' });
  });
  it('a copied scope cannot renew, invalidate or publish for a live owner', async () => {
    const current = fixture();
    const { scope, lease } = await current.capture();
    const copy = { ...scope };
    current.consumer.invalidate(copy);
    expect(current.consumer.isCurrent(scope)).toBe(true);
    await expect(current.consumer.acquire(copy)).rejects.toMatchObject({ status: 'superseded' });
    expect(() => current.consumer.assertCurrent(copy, lease)).toThrow();
  });
  it('scoped invalidation cannot clear a later account and disposal invalidates every scope', async () => {
    const current = fixture();
    const { scope } = await current.capture();
    current.manager.setOwner({ ...originalOwner(), userId: 'other-owned-user' });
    const revision = current.manager.getSnapshot().revision;
    current.consumer.invalidate(scope);
    expect(current.manager.getSnapshot().revision).toBe(revision);
    current.manager.setOwner(originalOwner());
    const next = await current.capture();
    current.manager.dispose();
    expect(current.consumer.isCurrent(next.scope)).toBe(false);
    await expect(current.consumer.acquire(next.scope)).rejects.toMatchObject({ status: 'superseded' });
  });
  it('consumer disposal clears the bridge without disposing an independently owned manager', async () => {
    const current = fixture();
    const { lease, scope } = await current.capture();
    current.consumer.dispose();
    current.consumer.dispose();
    expect(current.consumer.capture(lease.token)).toBeNull();
    expect(current.consumer.remember(lease)).toBe(false);
    expect(current.consumer.isCurrent(scope)).toBe(false);
    expect(current.manager.isCurrent(lease)).toBe(true);
    await expect(current.consumer.acquire(scope)).rejects.toMatchObject({ status: 'superseded' });
  });
  it('bounds the compatibility bearer registry while existing client scopes still renew', async () => {
    const current = fixture();
    const { scope, lease } = await current.capture();
    for (let issuance = 0; issuance < 70; issuance += 1) {
      current.advance(111_000);
      await current.consumer.acquire(scope);
    }
    expect(current.consumer.capture(lease.token)).toBeNull();
    expect(current.consumer.isCurrent(scope)).toBe(true);
    expect((await current.consumer.acquire(scope)).status).toBe('admitted');
  });
});
