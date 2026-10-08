// Which of the climber's own spray walls to make available offline, and which
// to take back (owner decision, 2026-10): a wall lives in a garage or a
// basement, the one place with no signal, so the owner should never have to
// remember a switch to climb on it there.
//
// Pure, so the rules have one test and no filesystem: the component that acts
// on the plan (`OwnedSprayWallsOfflinePin`) only runs the toggle's own enable
// path and the Storage screen's own remove path.
//
// The rules:
//
//  - **Pinned once, then the owner's switch.** An owned wall the ledger has not
//    seen is turned on through the same path the "Available offline" switch
//    uses, and recorded. One the ledger has seen is left alone, so an owner who
//    turns it off (on My Boards, or by removing it in Storage) keeps it off. A
//    wall already on when first seen is only recorded.
//  - **Ownership is `ownerId === viewer`.** `isOwned` means "I own the physical
//    board", a different question (`spray-detail-rows.ts`).
//  - **Losing a wall takes its download.** A pinned wall that is still in the
//    list but whose `ownerId` now names somebody else is removed from the device,
//    the way Storage's Remove does it, and dropped from the ledger. An unknown
//    `ownerId` decides nothing. A wall missing from the list decides nothing
//    either: `myBoards` leaves archived walls out, and those stay downloaded so
//    they open offline. A deleted wall is handled by `forgetDeletedSprayWall`
//    and the tombstone sink.
//  - **One account.** The ledger names its account; another account's ledger
//    reads as empty and is replaced.

import { offlineBoardKeyForBoard } from '@boardsesh/offline-sync';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { OwnedSprayWallPinLedger } from '../settings/types';

/**
 * At most this many walls are remembered. Ten live walls and fifty archived
 * ones is the most one account can own (`MAX_SPRAY_WALLS_PER_USER`,
 * `MAX_ARCHIVED_SPRAY_WALLS_PER_USER`); the rest is headroom. The oldest go first.
 */
export const MAX_OWNED_SPRAY_WALL_PINS = 128;

export type OwnedSprayWallPinBoard = Pick<UserBoard, 'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'ownerId'>;

export type OwnedSprayWallPinPlan<Board extends OwnedSprayWallPinBoard> = {
  /** Owned walls seen for the first time and not yet on: turn them on. */
  pin: Board[];
  /** Pinned walls the climber no longer owns: take their download off the phone. */
  unpin: Board[];
  /** The ledger to store, or `null` when nothing changed. */
  ledger: OwnedSprayWallPinLedger | null;
};

export function planOwnedSprayWallPins<Board extends OwnedSprayWallPinBoard>(input: {
  boards: readonly Board[];
  viewerUserId: string;
  ledger: OwnedSprayWallPinLedger | null;
  enabledScopeKeys: ReadonlySet<string>;
}): OwnedSprayWallPinPlan<Board> {
  const { boards, viewerUserId, enabledScopeKeys } = input;
  const ledger = input.ledger?.userId === viewerUserId ? input.ledger : null;
  const pinned = new Set(ledger?.wallUuids ?? []);
  const nextWallUuids = [...pinned];
  const pin: Board[] = [];
  const unpin: Board[] = [];
  let changed = ledger === null && input.ledger !== null;

  for (const board of boards) {
    if (board.boardType !== 'spray' || !board.uuid) continue;
    const ownerId = typeof board.ownerId === 'string' && board.ownerId.length > 0 ? board.ownerId : null;
    if (ownerId === null) continue;

    if (ownerId !== viewerUserId) {
      if (!pinned.has(board.uuid)) continue;
      pinned.delete(board.uuid);
      nextWallUuids.splice(nextWallUuids.indexOf(board.uuid), 1);
      if (enabledScopeKeys.has(offlineBoardKeyForBoard(board))) unpin.push(board);
      changed = true;
      continue;
    }

    if (pinned.has(board.uuid)) continue;
    pinned.add(board.uuid);
    nextWallUuids.push(board.uuid);
    changed = true;
    if (!enabledScopeKeys.has(offlineBoardKeyForBoard(board))) pin.push(board);
  }

  if (!changed) return { pin, unpin, ledger: null };
  return { pin, unpin, ledger: { userId: viewerUserId, wallUuids: trimToCap(nextWallUuids, boards) } };
}

/**
 * Over the cap, walls the roster no longer names go first (deleted, or
 * archived and long gone), oldest first; then the oldest overall. Evicting a
 * wall the roster still names would forget an owner's "keep it off" and pin it
 * again on the next run.
 */
function trimToCap(wallUuids: string[], boards: readonly OwnedSprayWallPinBoard[]): string[] {
  let excess = wallUuids.length - MAX_OWNED_SPRAY_WALL_PINS;
  if (excess <= 0) return wallUuids;
  const inRoster = new Set(boards.map((board) => board.uuid));
  const evicted = new Set<string>();
  for (const wallUuid of wallUuids) {
    if (excess === 0) break;
    if (inRoster.has(wallUuid)) continue;
    evicted.add(wallUuid);
    excess -= 1;
  }
  for (const wallUuid of wallUuids) {
    if (excess === 0) break;
    if (evicted.has(wallUuid)) continue;
    evicted.add(wallUuid);
    excess -= 1;
  }
  return wallUuids.filter((wallUuid) => !evicted.has(wallUuid));
}
