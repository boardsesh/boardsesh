// What the gym-first screens (#8151) show, as pure functions of what they
// know, so every state is a row in a table test. The rule they share with the
// first-board picker (`first-board-gym-state.ts`): a failed lookup is never
// drawn as an empty one. "No boards here" tells a climber standing in a gym to
// add a second copy of the wall in front of them.

import type { BoardName } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { LocationPermission, LocationStatus } from '../use-device-location';

/**
 * The "Use my location" row on the gym search.
 *
 * - `not_asked`: the button and its reason line. Never asked on open: the
 *   screen only reads a permission the climber already gave.
 * - `loading`: asking, or waiting for a fix.
 * - `granted`: nothing to say; the gyms are sorted around them.
 * - `denied`: off on the phone. Search by name, Open Settings where it can.
 * - `blocked_web`: a browser refusal is final (`locationPermissionFrom`), and
 *   only the site's settings can undo it, which an app can't open.
 */
export type LocationRowState = 'not_asked' | 'loading' | 'granted' | 'denied' | 'blocked_web';

export function locationRowState({
  status,
  permission,
  platform,
}: {
  status: LocationStatus;
  permission: LocationPermission;
  platform: string;
}): LocationRowState {
  if (status === 'granted') return 'granted';
  if (status === 'loading') return 'loading';
  const refused = status === 'denied' || status === 'unavailable' || permission === 'blocked';
  if (!refused) return 'not_asked';
  return platform === 'web' && permission === 'blocked' ? 'blocked_web' : 'denied';
}

/**
 * One lookup on these screens (the gyms, a gym's walls, the board search).
 * Rows already on screen stay through a refetch, failed or not.
 */
export type LookupState = 'idle' | 'offline' | 'loading' | 'failed' | 'empty' | 'listed';

export function lookupState({
  enabled,
  offline,
  isLoading,
  isError,
  count,
}: {
  /** Whether the lookup has what it needs to run (a gym, a type, a query). */
  enabled: boolean;
  offline: boolean;
  isLoading: boolean;
  isError: boolean;
  /** Rows the last answer carried, or null when there is no answer yet. */
  count: number | null;
}): LookupState {
  if (!enabled) return 'idle';
  if (count !== null && count > 0) return 'listed';
  if (offline) return 'offline';
  if (isError) return 'failed';
  if (isLoading || count === null) return 'loading';
  return 'empty';
}

/**
 * The row under a gym's wall list.
 *
 * - `hidden`: while the walls load, or offline: nothing to confirm against.
 * - `sign_in`: signed out, browsing works but adding needs an account.
 * - `report`: the gym can't take a board from here (no coordinates, so the
 *   server's 150 m link check would refuse, and the viewer can't edit it).
 *   Report a problem instead, so someone can fix the listing.
 * - `confirm`: walls are listed; ask before adding another.
 * - `add_anyway`: the lookup failed; say so, then add.
 * - `direct`: no walls listed: straight to the builder, nothing to confirm.
 */
export type NotListedRowState = 'hidden' | 'sign_in' | 'report' | 'confirm' | 'add_anyway' | 'direct';

export function notListedRowState({
  walls,
  signedIn,
  gymLinkable,
}: {
  walls: LookupState;
  signedIn: boolean;
  /** The gym has coordinates, or the viewer can edit it. */
  gymLinkable: boolean;
}): NotListedRowState {
  if (walls === 'loading' || walls === 'offline' || walls === 'idle') return 'hidden';
  if (!signedIn) return 'sign_in';
  if (!gymLinkable) return 'report';
  switch (walls) {
    case 'listed':
      return 'confirm';
    case 'failed':
      return 'add_anyway';
    case 'empty':
      return 'direct';
  }
}

/** A board type the builder can set up (spray walls have their own wizard). */
export function isPickableBoardType(boardType: string | null | undefined): boardType is BoardName {
  return boardType != null && (SUPPORTED_BOARDS as readonly string[]).includes(boardType);
}

/**
 * The board type a gym's wall list opens on when the entry didn't say: the
 * type the gym has most of (ties to the first in the supported order), or
 * null when it has none, and the climber picks.
 */
export function likelyBoardType(boards: readonly { boardType: string }[] | undefined): BoardName | null {
  if (!boards || boards.length === 0) return null;
  const counts = new Map<BoardName, number>();
  for (const board of boards) {
    if (isPickableBoardType(board.boardType)) counts.set(board.boardType, (counts.get(board.boardType) ?? 0) + 1);
  }
  let best: BoardName | null = null;
  let bestCount = 0;
  for (const boardType of SUPPORTED_BOARDS) {
    const count = counts.get(boardType) ?? 0;
    if (count > bestCount) {
      best = boardType;
      bestCount = count;
    }
  }
  return best;
}
