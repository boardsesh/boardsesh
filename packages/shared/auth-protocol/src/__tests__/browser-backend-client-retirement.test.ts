import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';

function owner() {
  return {
    userId: 'owned-user',
    authSessionId: 'owned-login',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(scope = owner()) {
  return {
    user: { id: scope.userId },
    authSessionId: scope.authSessionId,
    authGeneration: scope.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
function reply(scope = owner(), token = 'bsbd1_OWNED') {
  return Response.json({ status: 'admitted', token, usableForMs: 120_000, owner: scope });
}
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply());
  const client = createBrowserBackendClient({
    ready: () => true,
    fetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => 100,
    schedule: () => () => {},
  });
  return { client, fetch };
}
describe('local selected browser credential retirement', () => {
  it('retires a known lease without asserting anonymity or permitting legacy fallback', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    const lease = await current.client.acquire(owner());
    const scope = current.client.capture(lease.token)!;
    current.client.retire();
    expect(current.client.getSnapshot().owner).toBeNull();
    expect(current.client.isSelected()).toBe(true);
    expect(current.client.isAnonymous()).toBe(false);
    expect(current.client.isCurrent(scope)).toBe(false);
    expect(current.client.capture(lease.token)).toBeNull();
    await expect(current.client.acquire(owner())).rejects.toMatchObject({ status: 'superseded' });
    expect(() => current.client.acceptSession({ user: { id: 'legacy-user' } })).toThrow();
    expect(current.fetch).toHaveBeenCalledTimes(1);
  });
  it('late first initialization cannot revive an owner after retirement and a new selection', async () => {
    const current = fixture();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((complete) => {
      resolve = complete;
    });
    current.fetch.mockImplementationOnce(async () => pending);
    current.client.acceptSession(session());
    const old = current.client.acquire(owner());
    const oldSignal = current.fetch.mock.calls[0][1]?.signal;
    current.client.retire();
    expect(oldSignal?.aborted).toBe(true);
    const next = { ...owner(), userId: 'other-owned-user', cursor: { ...owner().cursor, version: 2 } };
    current.client.acceptSession(session(next));
    current.fetch.mockResolvedValueOnce(reply(next, 'bsbd1_NEXT'));
    const accepted = await current.client.acquire(next);
    resolve(reply());
    await expect(old).rejects.toMatchObject({ status: 'superseded' });
    expect(current.client.getSnapshot().owner).toEqual(next);
    expect(current.client.capture(accepted.token)).not.toBeNull();
  });
  it('only another successful central session can restore the same owner and it creates new receipts', async () => {
    const current = fixture();
    current.client.acceptSession(session());
    const oldLease = await current.client.acquire(owner());
    const oldScope = current.client.capture(oldLease.token)!;
    current.client.retire();
    current.client.acceptSession(session());
    current.fetch.mockResolvedValueOnce(reply(owner(), 'bsbd1_RESTORED'));
    const newLease = await current.client.acquire(owner());
    expect(current.client.capture(newLease.token)).not.toBeNull();
    expect(current.client.isCurrent(oldScope)).toBe(false);
    expect(current.fetch).toHaveBeenCalledTimes(2);
  });
  it('retiring a previously anonymous view requires a new actual anonymous observation', () => {
    const current = fixture();
    current.client.acceptSession(session());
    current.client.acceptSession(null);
    expect(current.client.isAnonymous()).toBe(true);
    current.client.retire();
    expect(current.client.isAnonymous()).toBe(false);
    expect(current.client.isSelected()).toBe(true);
    current.client.acceptSession({});
    expect(current.client.isAnonymous()).toBe(true);
  });
  it('does not activate selected mode or manufacture an owner on the legacy path', () => {
    const current = fixture();
    current.client.acceptSession({ user: { id: 'legacy-user' } });
    current.client.retire();
    expect(current.client.isSelected()).toBe(false);
    expect(current.client.getSnapshot().owner).toBeNull();
    expect(current.fetch).not.toHaveBeenCalled();
  });
});
