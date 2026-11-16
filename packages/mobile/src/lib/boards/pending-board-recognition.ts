// The serial-less box the climber was standing at when they set off to find its
// board, held until they bind one.
//
// The picker's in-range slot hears a MoonBoard or a bare `Kilter Board` box but
// cannot say which board it is. Its three ways forward (Use my location, Search
// gyms, It's my own board) each lead to a different route: the picker's own Near
// you list, the gym map, or the builder. Whichever one binds a board of the
// box's type next, on any of those routes, is the board that box is: the bind
// (`useActivateBoard`) hands it to `rememberRecognizedBoardDevice`, and the next
// picker open names the box straight away. Back on the picker, only a pick from
// the Near you list "Use my location" filtered keeps the hold; any other pick,
// and coming back from the gym map or the builder without a bind, drops it
// (app/boards/index.tsx).
//
// Module state, not React state: the routes that bind do not share a provider
// with the picker, and the answer only has to outlive one trip through them.
// Ten minutes covers a builder run or a browse on the map; past that, a bind is
// unlikely to be about the box any more. A bind of another board type leaves it
// waiting. Sign-out clears it (remembered-boards-sign-out.ts).

import type { BoardName } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { rememberRecognizedBoardDevice } from '../ble/recognized-board-devices-store';

export const PENDING_BOARD_RECOGNITION_TTL_MS = 10 * 60 * 1000;

export type PendingBoardRecognition = {
  /** The box's OS Bluetooth id, as the scan heard it. */
  deviceId: string;
  /** The box's board type: only a board of this type can be it. */
  boardType: BoardName;
  /** Epoch ms after which a bind no longer counts. */
  expiresAt: number;
};

/** What a bind does with the pending recognition; see `pendingRecognitionOutcome`. */
export type PendingRecognitionOutcome = 'nothing_pending' | 'expired' | 'other_type' | 'remember';

let pendingRecognition: PendingBoardRecognition | null = null;

/**
 * Hold `deviceId` until the next bind of a board of `boardType`, for
 * PENDING_BOARD_RECOGNITION_TTL_MS. Replaces whatever was held: the latest
 * box the climber acted on is the one they are standing at.
 */
export function setPendingBoardRecognition(
  { deviceId, boardType }: { deviceId: string; boardType: BoardName },
  nowMs: number = Date.now(),
): void {
  pendingRecognition = { deviceId, boardType, expiresAt: nowMs + PENDING_BOARD_RECOGNITION_TTL_MS };
}

/** Drop the held box: sign-out, or a bind that used it. */
export function clearPendingBoardRecognition(): void {
  pendingRecognition = null;
}

/** The held box, or null. For tests and diagnostics; binds go through `consumePendingBoardRecognition`. */
export function readPendingBoardRecognition(): PendingBoardRecognition | null {
  return pendingRecognition;
}

/**
 * What a bind of `boardType` at `nowMs` does with `pending`. Pure, so every
 * case is a table row.
 */
export function pendingRecognitionOutcome(
  pending: PendingBoardRecognition | null,
  boardType: string,
  nowMs: number,
): PendingRecognitionOutcome {
  if (!pending) return 'nothing_pending';
  if (nowMs >= pending.expiresAt) return 'expired';
  return toBoardName(boardType) === pending.boardType ? 'remember' : 'other_type';
}

/**
 * Called after every successful bind. A bind of the held box's type binds the
 * box to that board and clears the hold; an expired hold is cleared; a bind of
 * another type leaves it. Never rejects.
 */
export function consumePendingBoardRecognition(
  board: { uuid: string | null | undefined; boardType: string },
  nowMs: number = Date.now(),
): Promise<void> {
  const pending = pendingRecognition;
  switch (pendingRecognitionOutcome(pending, board.boardType, nowMs)) {
    case 'nothing_pending':
    case 'other_type':
      return Promise.resolve();
    case 'expired':
      pendingRecognition = null;
      return Promise.resolve();
    case 'remember':
      pendingRecognition = null;
      // `pending` is non-null here: the outcome is only 'remember' for a hold.
      return pending ? rememberRecognizedBoardDevice(pending.deviceId, board) : Promise.resolve();
  }
}
