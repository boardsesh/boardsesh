// The pinnable quick-filter capsules of the playlist-style lists (a playlist, a
// smart list, a setter page): which controls a climber can pin to the chip row
// under the list's header, the order they render in, and the pins a fresh
// install starts with. The filter sheet is the full set; the row is the
// climber's pinned subset (same idea as the climbs catalog in pinnable-chips.ts,
// with its own kinds and storage key).
//
// Left out on purpose: Recent (a playlist keeps no saved searches), Collection
// (its My drafts option has no meaning inside a playlist), Tall / Wide (rare on
// a list someone else built) and the Setters / Holds / Board region pickers
// (they open a route from the sheet; the Climbs row has no chip for them
// either). "Fits my board" is playlist-only.
//
// Pure, so the store, the session hook, the sheet's pin toggles and the token
// row all read one list without pulling in React or native code.

import type { FilterChipKind } from './pinnable-chips';

/**
 * Every pinnable playlist capsule, in the sheet's order (Sort last): the order
 * the defaults draw in and unpinned kinds list in on the Quick filters page.
 * Pinned chips draw in the climber's saved order.
 */
export const PLAYLIST_PINNABLE_CHIP_KINDS = [
  'grade',
  'accuracy',
  'progress',
  'climbType',
  'beta',
  'popularity',
  'rating',
  'boardFit',
  'sort',
] as const satisfies readonly FilterChipKind[];

export type PlaylistPinnableChipKind = (typeof PLAYLIST_PINNABLE_CHIP_KINDS)[number];

/** The catalog the store and the Quick filters page read. */
export const PLAYLIST_PINNABLE_CHIP_CATALOG: readonly PlaylistPinnableChipKind[] = PLAYLIST_PINNABLE_CHIP_KINDS;

/** Pinned on a fresh install: Grade, Your progress and Sort, the row in the approved layout. */
export const PLAYLIST_DEFAULT_PINNED_CHIPS: readonly PlaylistPinnableChipKind[] = ['grade', 'progress', 'sort'];
