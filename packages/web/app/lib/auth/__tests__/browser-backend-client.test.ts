// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';

function owner() {
  return {
    userId: 'owned-user',
    authSessionId: 'owned-login',
    generation: 2,
    cursor: { bindingId: 'a'.repeat(64), version: 3 },
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
function fixture(ready = true) {
  let milliseconds = 0;
  const fetchLease = vi.fn<typeof fetch>(async () =>
    Response.json({ status: 'admitted', token: 'bsbd1_OWNED', usableForMs: 120_000, owner: owner() }),
  );
  const client = createBrowserBackendClient({
    ready: () => ready,
    fetch: fetchLease,
    endpoint: 'https://www.owned.example.test/api/internal/ws-auth',
    now: () => milliseconds,
    schedule: () => () => {},
  });
  return {
    client,
    fetchLease,
    advance(elapsed: number) {
      milliseconds += elapsed;
    },
    readiness(next: boolean) {
      ready = next;
    },
  };
}

describe('WWW memory-only selected backend credential client', () => {
  it('requires an owned selected-session observation before fetching a lease', async () => {
    const current = fixture();
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.fetchLease).not.toHaveBeenCalled();
    expect(current.client.acceptSession(session())).toContain('owned-login');
    const lease = await current.client.acquire(owner());
    expect(lease.token).toBe('bsbd1_OWNED');
    expect(current.client.capture(lease.token)).not.toBeNull();
    expect(current.fetchLease).toHaveBeenCalledWith('https://www.owned.example.test/api/internal/ws-auth', {
      credentials: 'include',
      cache: 'no-store',
      keepalive: false,
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(current.client.getSnapshot())).not.toContain('bsbd1_');
  });
  it('cannot bypass hardfalse readiness with selected response metadata', async () => {
    const current = fixture(false);
    expect(() => current.client.acceptSession(session())).toThrow();
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.fetchLease).not.toHaveBeenCalled();
    expect(current.client.getSnapshot().owner).toBeNull();
    expect(current.client.isAnonymous()).toBe(false);
  });
  it('retains legacy dispatch only before any selected observation', () => {
    const current = fixture();
    expect(current.client.acceptSession({ user: { id: 'legacy-owned-user' } })).toBeNull();
    expect(current.client.acceptSession(null)).toBeNull();
    current.client.acceptSession(session());
    expect(current.client.acceptSession(null)).toBe('selected-anonymous');
    expect(current.client.isAnonymous()).toBe(true);
    expect(() => current.client.acceptSession({ user: { id: 'legacy-owned-user' } })).toThrow();
    expect(current.client.isSelected()).toBe(true);
    expect(current.client.isAnonymous()).toBe(false);
  });
  it.each(['UID', 'SID', 'generation', 'version'] as const)(
    'retires current client scopes before publishing an accepted %s transition',
    async (change) => {
      const current = fixture();
      const firstKey = current.client.acceptSession(session());
      const lease = await current.client.acquire(owner());
      const scope = current.client.capture(lease.token)!;
      const next = owner();
      if (change === 'UID') next.userId = 'other-owned-user';
      if (change === 'SID') next.authSessionId = 'same-user-new-login';
      if (change === 'generation') next.generation += 1;
      if (change === 'version') next.cursor.version += 1;
      expect(current.client.acceptSession(session(next))).not.toBe(firstKey);
      expect(current.client.isCurrent(scope)).toBe(false);
      await expect(current.client.acquireScope(scope)).rejects.toMatchObject({ status: 'superseded' });
      expect(current.fetchLease).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses an owner supplied by an old render instead of fetching for it', async () => {
    const current = fixture();
    current.client.acceptSession(session({ ...owner(), authSessionId: 'new-login' }));
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'superseded' });
    expect(current.fetchLease).not.toHaveBeenCalled();
  });
  it('invalid selected metadata invalidates the old lease instead of leaving a fallback usable', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    const lease = await current.client.acquire(owner());
    const scope = current.client.capture(lease.token)!;
    expect(() => current.client.acceptSession({ ...session(), browserSelection: undefined })).toThrow();
    expect(current.client.isCurrent(scope)).toBe(false);
    expect(current.client.capture(lease.token)).toBeNull();
    expect(current.client.getSnapshot().owner).toBeNull();
  });
  it('debits the full observed response/body roundtrip from the lease duration', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    current.fetchLease.mockImplementationOnce(async () => {
      current.advance(250);
      return Response.json({ status: 'admitted', token: 'bsbd1_OWNED', usableForMs: 1000, owner: owner() });
    });
    expect(await current.client.acquire(owner())).toMatchObject({ usableForMs: 750 });
  });
  it.each([
    { status: 'denied', code: 401 },
    { status: 'conflict', code: 409 },
    { status: 'unavailable', code: 503 },
  ] as const)('preserves explicit $status without an anonymous retry', async ({ status, code }) => {
    const current = fixture();
    current.client.acceptSession(session());
    current.fetchLease.mockResolvedValueOnce(Response.json({ status }, { status: code }));
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => Response.json({ status: 'denied' }),
    () => Response.json({ status: 'admitted', token: 'bsbd1_OWNED', usableForMs: 120_001, owner: owner() }),
    () => Response.json({ status: 'admitted', token: 'bsbd1_OWNED', usableForMs: 1000, owner: owner(), raw: 'source' }),
    () => new Response(new Uint8Array([0xff]), { status: 200 }),
    () => new Response(' '.repeat(16_385), { status: 200 }),
  ])('refuses malformed, mismatched, oversized or invalid UTF8 replies', async (response) => {
    const current = fixture();
    current.client.acceptSession(session());
    current.fetchLease.mockResolvedValueOnce(response());
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.client.capture('bsbd1_OWNED')).toBeNull();
  });
  it('never returns a valid cached lease after readiness closes', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    await current.client.acquire(owner());
    current.readiness(false);
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'unavailable' });
    expect(current.fetchLease).toHaveBeenCalledTimes(1);
  });
  it('same-owner refresh keeps current clients usable only within their exact receipts', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    const lease = await current.client.acquire(owner());
    const scope = current.client.capture(lease.token)!;
    current.advance(90_000);
    current.fetchLease.mockResolvedValueOnce(
      Response.json({ status: 'admitted', token: 'bsbd1_RENEWED', usableForMs: 120_000, owner: owner() }),
    );
    const renewed = await current.client.acquireScope(scope);
    expect(renewed.token).toBe('bsbd1_RENEWED');
    current.advance(30_000);
    expect(() => current.client.assertCurrent(scope, lease)).toThrow();
    expect(() => current.client.assertCurrent(scope, renewed)).not.toThrow();
  });
});
