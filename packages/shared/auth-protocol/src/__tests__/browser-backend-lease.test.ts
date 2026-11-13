import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendLeaseManager, type BrowserBackendLeaseOwner } from '../browser-backend-lease';

function owner(): BrowserBackendLeaseOwner {
  return {
    userId: 'owned-user',
    authSessionId: 'owned-session',
    generation: 3,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
}
function deferred() {
  let resolve!: (reply: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function reply(scope = owner(), token = 'bsbd1_OWNEDFIRST', usableForMs = 120_000) {
  return { status: 'admitted' as const, token, usableForMs, owner: scope };
}
function fixture(fetcher?: (scope: Readonly<BrowserBackendLeaseOwner>, signal: AbortSignal) => Promise<unknown>) {
  let milliseconds = 100;
  const timers = new Set<{ deadline: number; callback: () => void }>();
  const fetchLease = vi.fn(fetcher ?? (async (scope) => reply(scope)));
  const manager = createBrowserBackendLeaseManager({
    now: () => milliseconds,
    fetchLease,
    schedule(callback, delay) {
      const timer = { callback, deadline: milliseconds + delay };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  });
  manager.setOwner(owner());
  return {
    manager,
    fetchLease,
    timers,
    advance(elapsed: number) {
      milliseconds += elapsed;
      for (const timer of timers)
        if (timer.deadline <= milliseconds) {
          timers.delete(timer);
          timer.callback();
        }
    },
  };
}

describe('process-memory selected browser backend leases', () => {
  it('coalesces one owner request and returns only live bounded credentials', async () => {
    const pending = deferred();
    const current = fixture(async () => pending.promise);
    const first = current.manager.acquire(owner());
    const second = current.manager.acquire(owner());
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
    pending.resolve(reply());
    expect(await first).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDFIRST' });
    expect(await second).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDFIRST' });
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDFIRST' });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
    expect(current.timers.size).toBe(0);
  });
  it('debits its entire monotonic roundtrip instead of trusting a remote absolute clock', async () => {
    const pending = deferred();
    const current = fixture(async () => pending.promise);
    const first = current.manager.acquire(owner());
    current.advance(200);
    pending.resolve(reply(owner(), 'bsbd1_OWNEDFIRST', 1000));
    expect(await first).toMatchObject({ status: 'admitted', usableForMs: 800 });
    current.advance(501);
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted', usableForMs: 299 });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
  });
  it('does not publish a reply that spent its whole lease in flight', async () => {
    const pending = deferred();
    const current = fixture(async () => pending.promise);
    const first = current.manager.acquire(owner());
    current.advance(1000);
    pending.resolve(reply(owner(), 'bsbd1_EXPIRED', 1000));
    expect(await first).toEqual({ status: 'unavailable' });
  });
  it.each(['UID', 'SID', 'generation', 'version', 'binding'] as const)(
    'discards delayed A after a confirmed %s change while B stays usable',
    async (change) => {
      const firstReply = deferred();
      const nextReply = deferred();
      const current = fixture();
      current.fetchLease
        .mockImplementationOnce(async () => firstReply.promise)
        .mockImplementationOnce(async () => nextReply.promise);
      const previous = current.manager.acquire(owner());
      const oldSignal = current.fetchLease.mock.calls[0][1];
      const next = owner();
      if (change === 'UID') next.userId = 'other-user';
      if (change === 'SID') next.authSessionId = 'same-user-new-session';
      if (change === 'generation') next.generation += 1;
      if (change === 'version') next.cursor.version += 1;
      if (change === 'binding') next.cursor.bindingId = 'b'.repeat(64);
      current.manager.setOwner(next);
      expect(oldSignal.aborted).toBe(true);
      const replacement = current.manager.acquire(next);
      nextReply.resolve(reply(next, 'bsbd1_OWNEDNEXT'));
      expect(await replacement).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDNEXT' });
      firstReply.resolve(reply());
      expect(await previous).toEqual({ status: 'superseded' });
      expect(await current.manager.acquire(next)).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDNEXT' });
      expect(await current.manager.acquire(owner())).toEqual({ status: 'superseded' });
    },
  );
  it('captures nested owner inputs and keeps the same confirmed owner across callback churn', async () => {
    const pending = deferred();
    const current = fixture(async () => pending.promise);
    const scope = owner();
    const first = current.manager.acquire(scope);
    const snapshot = current.manager.getSnapshot();
    current.manager.setOwner({ ...owner(), cursor: { ...owner().cursor } });
    expect(current.manager.getSnapshot()).toBe(snapshot);
    scope.userId = 'caller-mutated-user';
    scope.cursor.version = 99;
    expect(Object.isFrozen(current.fetchLease.mock.calls[0][0].cursor)).toBe(true);
    pending.resolve(reply());
    expect(await first).toMatchObject({ status: 'admitted', owner: owner() });
    expect(current.fetchLease.mock.calls[0][1].aborted).toBe(false);
  });
  it('refreshes before expiry, retains only an unexpired same-owner lease through uncertainty', async () => {
    const current = fixture();
    await current.manager.acquire(owner());
    current.advance(111_000);
    current.fetchLease.mockResolvedValue({ status: 'unavailable' });
    expect(await current.manager.acquire(owner())).toMatchObject({
      status: 'admitted',
      token: 'bsbd1_OWNEDFIRST',
      usableForMs: 9000,
    });
    expect(current.fetchLease).toHaveBeenCalledTimes(2);
    current.advance(9000);
    expect(await current.manager.acquire(owner())).toEqual({ status: 'unavailable' });
    current.fetchLease.mockResolvedValue(reply(owner(), 'bsbd1_OWNEDRENEWED'));
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDRENEWED' });
  });
  it.each(['denied', 'conflict'] as const)('never falls back to cached credentials after %s', async (status) => {
    const current = fixture();
    await current.manager.acquire(owner());
    current.advance(111_000);
    current.fetchLease.mockResolvedValueOnce({ status });
    expect(await current.manager.acquire(owner())).toEqual({ status });
    current.fetchLease.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await current.manager.acquire(owner())).toEqual({ status: 'unavailable' });
  });
  it('refuses another returned owner without adopting it or retaining the old cached credential', async () => {
    const current = fixture();
    await current.manager.acquire(owner());
    current.advance(111_000);
    current.fetchLease.mockResolvedValueOnce(reply({ ...owner(), generation: 4 }, 'bsbd1_OTHEROWNER'));
    expect(await current.manager.acquire(owner())).toEqual({ status: 'conflict' });
    expect(current.manager.getSnapshot().owner).toEqual(owner());
    current.fetchLease.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await current.manager.acquire(owner())).toEqual({ status: 'unavailable' });
  });
  it('times out an abort-ignoring request, then recovers without a permanent pending state', async () => {
    const late = deferred();
    const current = fixture();
    current.fetchLease.mockImplementationOnce(async () => late.promise);
    const first = current.manager.acquire(owner());
    const signal = current.fetchLease.mock.calls[0][1];
    current.advance(10_000);
    expect(await first).toEqual({ status: 'unavailable' });
    expect(signal.aborted).toBe(true);
    expect(current.manager.getSnapshot().refreshing).toBe(false);
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted' });
    late.resolve(reply(owner(), 'bsbd1_LATEMUSTNOTPUBLISH'));
    await Promise.resolve();
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted', token: 'bsbd1_OWNEDFIRST' });
  });
  it.each([
    { token: 'legacy.source.jwe.bytes.parts' },
    { token: 'opaque-canonical-source' },
    { token: 'bsbd1_' + 'A'.repeat(4096) },
    { usableForMs: 0 },
    { usableForMs: 120_001 },
    { sourceCredential: 'never-a-public-reply' },
  ])('refuses malformed, unbounded or source credentials: %j', async (altered) => {
    const current = fixture(async () => ({ ...reply(), ...altered }));
    expect(await current.manager.acquire(owner())).toEqual({ status: 'unavailable' });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
  });
  it('keeps snapshots stable and bearer-free, isolates subscribers and scopes invalidation', async () => {
    const current = fixture();
    const notify = vi.fn();
    current.manager.subscribe(() => {
      throw new Error('Owned stale view');
    });
    current.manager.subscribe(notify);
    await current.manager.acquire(owner());
    expect(current.manager.getSnapshot()).toBe(current.manager.getSnapshot());
    expect(JSON.stringify(current.manager.getSnapshot())).not.toContain('bsbd1_');
    current.manager.invalidate({ ...owner(), authSessionId: 'old-login' });
    expect(await current.manager.acquire(owner())).toMatchObject({ status: 'admitted' });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
    current.manager.dispose();
    expect(notify).toHaveBeenCalled();
    expect(current.manager.getSnapshot()).toMatchObject({ owner: null, closed: true });
    expect(await current.manager.acquire(owner())).toEqual({ status: 'superseded' });
  });
  it('fails closed when an injected clock goes backwards', async () => {
    const current = fixture();
    await current.manager.acquire(owner());
    current.advance(-1);
    expect(await current.manager.acquire(owner())).toEqual({ status: 'unavailable' });
  });
  it('invalidates a cached positive between promise resolution and its consumer continuation', async () => {
    const current = fixture();
    const original = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(original)).toBe(true);
    const cached = current.manager.acquire(owner());
    current.manager.setOwner({ ...owner(), authSessionId: 'new-login' });
    const completed = await cached;
    expect(completed.status).toBe('admitted');
    expect(current.manager.isCurrent(completed)).toBe(false);
    expect(current.manager.isCurrent(original)).toBe(false);
  });
  it('refuses the old result after A to B to identical A scope facts', async () => {
    const current = fixture();
    const previous = await current.manager.acquire(owner());
    current.manager.setOwner({ ...owner(), userId: 'other-user' });
    current.manager.setOwner(owner());
    expect(current.manager.isCurrent(previous)).toBe(false);
    const next = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(next)).toBe(true);
    expect(current.manager.isCurrent(previous)).toBe(false);
  });
  it('binds a result receipt to scoped invalidation, exact expiry and disposal', async () => {
    const current = fixture();
    const original = await current.manager.acquire(owner());
    current.manager.invalidate({ ...owner(), authSessionId: 'older-login' });
    expect(current.manager.isCurrent(original)).toBe(true);
    current.manager.invalidate(owner());
    expect(current.manager.isCurrent(original)).toBe(false);
    const replacement = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(replacement)).toBe(true);
    current.advance(120_000);
    expect(current.manager.isCurrent(replacement)).toBe(false);
    const renewed = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(renewed)).toBe(true);
    current.manager.dispose();
    expect(current.manager.isCurrent(renewed)).toBe(false);
  });
  it('does not give copied, serialized or caller-constructed fields a current-result receipt', async () => {
    const current = fixture();
    const original = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(original)).toBe(true);
    expect(Object.isFrozen(original)).toBe(true);
    for (const copied of [{ ...original }, JSON.parse(JSON.stringify(original)), reply(), null, { status: 'denied' }])
      expect(current.manager.isCurrent(copied)).toBe(false);
  });
  it.each(['denied', 'conflict'] as const)('retires old result receipts after confirmed %s', async (status) => {
    const current = fixture();
    const original = await current.manager.acquire(owner());
    current.advance(111_000);
    current.fetchLease.mockResolvedValueOnce({ status });
    expect(await current.manager.acquire(owner())).toEqual({ status });
    expect(current.manager.isCurrent(original)).toBe(false);
  });
  it('retains a valid result through same-owner rolling lease refresh without changing its deadline', async () => {
    const current = fixture();
    const original = await current.manager.acquire(owner());
    current.advance(111_000);
    current.fetchLease.mockResolvedValueOnce(reply(owner(), 'bsbd1_NEWLEASE'));
    const renewed = await current.manager.acquire(owner());
    expect(current.manager.isCurrent(original)).toBe(true);
    expect(current.manager.isCurrent(renewed)).toBe(true);
    current.advance(9000);
    expect(current.manager.isCurrent(original)).toBe(false);
    expect(current.manager.isCurrent(renewed)).toBe(true);
  });
});
