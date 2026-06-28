import { describe, it, expect, vi } from 'vitest';
import { PlaylistMembershipStore } from '../playlist-membership-store';

describe('PlaylistMembershipStore', () => {
  it('returns a reference-stable set per climb so useSyncExternalStore can compare with Object.is', () => {
    const store = new PlaylistMembershipStore();
    store.setMembershipsFor([{ climbUuid: 'climb-1', playlistUuids: ['p1', 'p2'] }]);

    const first = store.getMembershipsForClimb('climb-1');
    const second = store.getMembershipsForClimb('climb-1');
    expect(first).toBe(second);
    expect([...first].sort()).toEqual(['p1', 'p2']);
  });

  it('returns the same shared empty set for unknown climbs', () => {
    const store = new PlaylistMembershipStore();
    const a = store.getMembershipsForClimb('missing-a');
    const b = store.getMembershipsForClimb('missing-b');
    expect(a.size).toBe(0);
    expect(a).toBe(b);
  });

  it('notifies once per batch and only when contents actually change', () => {
    const store = new PlaylistMembershipStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setMembershipsFor([
      { climbUuid: 'climb-1', playlistUuids: ['p1'] },
      { climbUuid: 'climb-2', playlistUuids: ['p2'] },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same contents (different array) — no notification, same set reference kept.
    const before = store.getMembershipsForClimb('climb-1');
    store.setMembershipsFor([{ climbUuid: 'climb-1', playlistUuids: ['p1'] }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getMembershipsForClimb('climb-1')).toBe(before);

    // A real change to one climb fires exactly one notification and swaps its set.
    store.setMembershipForClimb('climb-1', ['p1', 'p3']);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getMembershipsForClimb('climb-1')).not.toBe(before);
    expect([...store.getMembershipsForClimb('climb-1')].sort()).toEqual(['p1', 'p3']);
  });

  it('reset clears all memberships and notifies once (no-op when already empty)', () => {
    const store = new PlaylistMembershipStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();
    expect(listener).toHaveBeenCalledTimes(0);

    store.setMembershipsFor([{ climbUuid: 'climb-1', playlistUuids: ['p1'] }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getMembershipsForClimb('climb-1').size).toBe(0);
  });

  it('unsubscribe stops further notifications', () => {
    const store = new PlaylistMembershipStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setMembershipsFor([{ climbUuid: 'climb-1', playlistUuids: ['p1'] }]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setMembershipForClimb('climb-1', ['p1', 'p2']);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
