/**
 * Pure derivation of a single token's board-connection state for the iOS Live
 * Activity ContentState.
 *
 * iOS reads two optional ContentState fields:
 *   - boardConnection: 'connectedByMe' | 'heldByPeer' | 'disconnected'
 *   - holderDisplayName: the peer's name (only when heldByPeer)
 *
 * Both are OPTIONAL on the device: when the server omits them (holder/board
 * couldn't be resolved), each device gracefully falls back to its own App-Group
 * state. So callers OMIT both rather than guessing — see `resolveSessionHolder`
 * in `index.ts`, which returns `null` when it can't determine the holder.
 *
 * This file is intentionally pure (no Redis, no DB, no React): the truth table
 * is unit-tested directly in `board-connection.test.ts`.
 */

export type BoardConnectionState = 'connectedByMe' | 'heldByPeer' | 'disconnected';

/** The board's current holder, as resolved from `pubsub.getBoardWriter`. */
export interface BoardHolder {
  /** The holder's userId, or null for an anonymous (`conn:`) holder. */
  holderUserId: string | null;
  /** The holder's display name, when known (peer attribution). */
  holderDisplayName: string | null;
}

export interface DeriveBoardConnectionInput {
  /** The userId the push token is registered to (null when unattributed). */
  tokenUserId: string | null;
  /** The board's current holder userId, or null when nobody holds the board. */
  holderUserId: string | null;
  /** The holder's display name, when known. */
  holderDisplayName: string | null;
}

export interface DerivedBoardConnection {
  boardConnection: BoardConnectionState;
  /** Only set for `heldByPeer` when a display name is available. */
  holderDisplayName?: string;
}

/**
 * Derive a single token's board-connection state from the board's current
 * holder.
 *
 *   - no holder (holderUserId == null)             -> 'disconnected'
 *   - holder is this token's user (same userId)    -> 'connectedByMe'
 *   - a different / anonymous holder exists         -> 'heldByPeer'
 *
 * Note an anonymous holder always has holderUserId === null, so it is reported
 * as 'disconnected' here: with no userId we can't tell whether the anonymous
 * holder is *this* device or a peer, and there's no reliable display name. The
 * caller (resolveSessionHolder) only ever passes a holder with a non-null
 * userId; an anonymous `conn:` holder is normalized to null upstream so this
 * stays a simple, total function over the (tokenUserId, holderUserId) pair.
 */
export function deriveBoardConnection({
  tokenUserId,
  holderUserId,
  holderDisplayName,
}: DeriveBoardConnectionInput): DerivedBoardConnection {
  if (holderUserId === null) {
    return { boardConnection: 'disconnected' };
  }

  if (tokenUserId !== null && tokenUserId === holderUserId) {
    return { boardConnection: 'connectedByMe' };
  }

  // A different (or unattributed-token) holder owns the board.
  if (holderDisplayName) {
    return { boardConnection: 'heldByPeer', holderDisplayName };
  }
  return { boardConnection: 'heldByPeer' };
}
