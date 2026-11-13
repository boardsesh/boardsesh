import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '../browser-backend-client';

function session(userId = 'climber-a', version = 1) {
  const owner = {
    userId,
    authSessionId: `${userId}-login`,
    generation: 2,
    cursor: { bindingId: 'a'.repeat(64), version },
  };
  return {
    user: { id: userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  };
}

function fixture() {
  const first = session();
  const client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'admitted', token: 'bsbd1_PRIVATE', usableForMs: 60_000, owner: first.browserSelection }),
    ),
    endpoint: '/owned-lease',
    now: () => 0,
    schedule: () => () => {},
  });
  return { client, first };
}

describe('private accepted-session receipts for viewer-bound UI', () => {
  it('refuses late acceptance and subscriptions after disposal', () => {
    const { client } = fixture();
    client.acceptSession(null);
    client.dispose();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    expect(() => client.acceptSession(null)).toThrow();
    client.retire();
    client.dispose();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(client.isSessionCurrent(null)).toBe(false);
    expect(client.isAnonymous()).toBe(false);
  });
  it('notifies every observer and completes acceptance when an earlier observer throws', () => {
    const { client, first } = fixture();
    client.subscribe(() => {
      throw new Error('Owned throwing observer');
    });
    const notified = vi.fn();
    client.subscribe(notified);
    expect(() => client.acceptSession(first)).not.toThrow();
    expect(notified).toHaveBeenCalledOnce();
    client.retire();
    expect(notified).toHaveBeenCalledTimes(2);
    expect(() => client.acceptSession(null)).not.toThrow();
    expect(notified).toHaveBeenCalledTimes(3);
    expect(client.isSessionCurrent(null)).toBe(true);
    client.dispose();
  });
  it('refuses metadata, copied sessions, and changed objects without an owned acceptance', () => {
    const { client, first } = fixture();
    expect(client.isSessionCurrent(first)).toBe(false);
    client.acceptSession(first);
    expect(client.isSessionCurrent(first)).toBe(true);
    expect(client.isSessionCurrent(structuredClone(first))).toBe(false);
    first.browserSelection.cursor.version += 1;
    expect(client.isSessionCurrent(first)).toBe(false);
    client.dispose();
  });

  it.each(['retire', 'invalidate', 'dispose'] as const)(
    'hides an accepted view immediately after %s',
    async (action) => {
      const { client, first } = fixture();
      client.acceptSession(first);
      const lease = await client.acquire(first.browserSelection);
      const scope = client.capture(lease.token)!;
      const listener = vi.fn();
      const unsubscribe = client.subscribe(listener);
      const before = client.getSnapshot();
      if (action === 'invalidate') client.invalidate(scope);
      else client[action]();
      expect(client.isSessionCurrent(first)).toBe(false);
      expect(client.getSnapshot()).not.toBe(before);
      expect(listener).toHaveBeenCalled();
      unsubscribe();
      client.dispose();
    },
  );

  it('refuses an earlier session after an exact tuple A to B to A transition', () => {
    const { client, first } = fixture();
    client.acceptSession(first);
    client.acceptSession(session('climber-b', 2));
    const returned = session();
    client.acceptSession(returned);
    expect(client.isSessionCurrent(first)).toBe(false);
    expect(client.isSessionCurrent(returned)).toBe(true);
    client.dispose();
  });

  it('requires another actual accepted response after same-owner invalidation', async () => {
    const { client, first } = fixture();
    client.acceptSession(first);
    const lease = await client.acquire(first.browserSelection);
    client.invalidate(client.capture(lease.token)!);
    expect(client.isSessionCurrent(first)).toBe(false);
    const refreshed = session();
    client.acceptSession(refreshed);
    expect(client.isSessionCurrent(refreshed)).toBe(true);
    expect(client.isSessionCurrent(first)).toBe(false);
    client.dispose();
  });

  it('publishes malformed selected metadata even when no manager owner existed', () => {
    const { client } = fixture();
    client.acceptSession({ user: { id: 'legacy-climber' } });
    const before = client.getSnapshot();
    const listener = vi.fn();
    client.subscribe(listener);
    expect(() => client.acceptSession({ browserSelection: undefined })).toThrow();
    expect(client.getSnapshot()).toMatchObject({ selected: true, anonymous: false, owner: null });
    expect(client.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('keeps anonymous confirmation distinct from initial state and local retirement', () => {
    const { client } = fixture();
    expect(client.isSessionCurrent(null)).toBe(false);
    client.acceptSession(null);
    expect(client.isSessionCurrent(null)).toBe(true);
    const listener = vi.fn();
    client.subscribe(listener);
    client.retire();
    expect(client.isSessionCurrent(null)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('keeps all receipt state and bearer bytes out of the stable public snapshot', async () => {
    const { client, first } = fixture();
    client.acceptSession(first);
    await client.acquire(first.browserSelection);
    expect(client.getSnapshot()).toBe(client.getSnapshot());
    expect(JSON.stringify(client.getSnapshot())).not.toContain('PRIVATE');
    expect(JSON.stringify(client.getSnapshot())).not.toContain('expires');
    client.dispose();
  });
});
