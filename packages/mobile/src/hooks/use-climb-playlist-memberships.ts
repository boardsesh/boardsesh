import { useSyncExternalStore } from 'react';
import { playlistMembershipStore } from '@boardsesh/climb-actions';

// Stable empty snapshot for the server path. Membership is never available
// during SSR/hydration, so a shared frozen set keeps `Object.is` happy.
const EMPTY_MEMBERSHIPS: ReadonlySet<string> = new Set();

/**
 * Subscribe to a single climb's playlist membership from the shared
 * `playlistMembershipStore`. Per-UUID subscription: a row only re-renders when
 * its OWN climb's membership changes, never when another row's does. The store
 * returns a reference-stable `Set` (a shared empty set until the climb is
 * fetched / when it's in no playlists), so `useSyncExternalStore`'s `Object.is`
 * check holds and there's no render loop.
 */
export function useClimbPlaylistMemberships(climbUuid: string): ReadonlySet<string> {
  return useSyncExternalStore(
    playlistMembershipStore.subscribe,
    () => playlistMembershipStore.getMembershipsForClimb(climbUuid),
    () => EMPTY_MEMBERSHIPS,
  );
}
