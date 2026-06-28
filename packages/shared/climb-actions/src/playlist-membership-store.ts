/**
 * External store for per-climb playlist membership, enabling per-UUID
 * subscriptions via `useSyncExternalStore`. Sibling to `favorites-store.ts`:
 * each climb row subscribes to only its own membership, so a batch fetch (or a
 * single add/remove) re-renders just the rows whose membership actually changed
 * — not the whole list.
 *
 * Pure class with no React or DOM coupling. The `subscribe` signature matches
 * `useSyncExternalStore` so web and mobile can point components straight at the
 * singleton.
 *
 * Reference stability is load-bearing: `getMembershipsForClimb` returns the SAME
 * `Set` instance until that climb's contents change (and a shared frozen empty
 * set for misses), so `useSyncExternalStore`'s `Object.is` snapshot check holds
 * across renders and never loops.
 */
const EMPTY_MEMBERSHIP: ReadonlySet<string> = new Set();

export type ClimbPlaylistMembershipEntry = {
  climbUuid: string;
  playlistUuids: readonly string[];
};

export class PlaylistMembershipStore {
  private membershipByClimb = new Map<string, ReadonlySet<string>>();
  private listeners = new Set<() => void>();

  /** Subscribe to store changes (signature expected by useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Read a climb's playlist membership. Returns a reference-stable `Set` (the
   * same instance until the climb's contents change, or a shared empty set for
   * climbs not yet fetched / in no playlists) so a per-UUID
   * `useSyncExternalStore(store.subscribe, () => store.getMembershipsForClimb(uuid))`
   * compares equal with `Object.is` and only re-renders on a real change.
   */
  getMembershipsForClimb = (climbUuid: string): ReadonlySet<string> => {
    return this.membershipByClimb.get(climbUuid) ?? EMPTY_MEMBERSHIP;
  };

  /**
   * Merge a batch of fetched memberships. A climb's `Set` is replaced (and a
   * single notification fired) only when its contents differ from what's stored,
   * so unchanged climbs keep their reference and don't re-render.
   */
  setMembershipsFor(entries: Iterable<ClimbPlaylistMembershipEntry>): void {
    let changed = false;
    for (const { climbUuid, playlistUuids } of entries) {
      const existing = this.membershipByClimb.get(climbUuid);
      const next = new Set(playlistUuids);
      if (existing && existing.size === next.size && [...next].every((id) => existing.has(id))) continue;
      this.membershipByClimb.set(climbUuid, next);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Replace a single climb's membership (e.g. after an optimistic add/remove). */
  setMembershipForClimb(climbUuid: string, playlistUuids: readonly string[]): void {
    this.setMembershipsFor([{ climbUuid, playlistUuids }]);
  }

  /**
   * Drop everything. Called when the board/layout changes so memberships from
   * the previous board can't leak onto the new board's rows. No-op (and no
   * notification) when already empty.
   */
  reset(): void {
    if (this.membershipByClimb.size === 0) return;
    this.membershipByClimb = new Map();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const playlistMembershipStore = new PlaylistMembershipStore();
