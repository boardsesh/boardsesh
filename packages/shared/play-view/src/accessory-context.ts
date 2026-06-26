// Renderer-agnostic logic for the persistent "active climb" accessory bar.
//
// The bar historically rendered an identical climb name in three different
// situations — your queue head, the climb lit on a board YOU drive, and a peer's
// lit climb in a party session — so on social/browsing screens a bare name read
// as a directive ("climb this now") rather than status ("this is what's lit").
//
// This derives a small "now playing" context from the board-connection state so
// the UI can label each situation distinctly (the eyebrow caption) and demote the
// queue-only case. Inputs are primitives so web and mobile can share it.

/** Tri-state board ownership (mirrors the mobile `BoardConnection` union). */
export type AccessoryBoardConnection = 'disconnected' | 'connectedByMe' | 'heldByPeer';

/** Visual tier: the loud branded now-playing bar vs the quiet resume affordance. */
export type AccessoryTier = 'nowPlaying' | 'resume';

/**
 * Which status the eyebrow caption announces:
 * - `live`   — you are driving a connected board (this is what's lit).
 * - `peer`   — a session teammate is driving the board (read-only to you).
 * - `upNext` — nothing is lit; this is just your next queued climb.
 */
export type AccessoryEyebrowKind = 'live' | 'peer' | 'upNext';

export type AccessoryContext = {
  tier: AccessoryTier;
  eyebrow: {
    kind: AccessoryEyebrowKind;
    /** Peer display name for the `peer` kind, else `null`. */
    name: string | null;
  };
  /**
   * Whether the trailing tick (log ascent) should show. Hidden for a peer's
   * climb — you can't log someone else's send from the status bar.
   */
  showTick: boolean;
};

export type AccessoryContextInput = {
  boardConnection: AccessoryBoardConnection;
  /** Display name of the peer driving the wall, when `heldByPeer` (else `null`). */
  holderDisplayName: string | null;
};

/**
 * Maps the board-connection state to the accessory's now-playing context.
 *
 * - `heldByPeer`    → now-playing, eyebrow names the peer, no tick (read-only).
 * - `connectedByMe` → now-playing, "live" eyebrow, tick enabled.
 * - `disconnected`  → resume tier, "up next" eyebrow (just your queue head).
 */
export function deriveAccessoryContext({
  boardConnection,
  holderDisplayName,
}: AccessoryContextInput): AccessoryContext {
  if (boardConnection === 'heldByPeer') {
    return {
      tier: 'nowPlaying',
      eyebrow: { kind: 'peer', name: holderDisplayName },
      showTick: false,
    };
  }
  if (boardConnection === 'connectedByMe') {
    return {
      tier: 'nowPlaying',
      eyebrow: { kind: 'live', name: null },
      showTick: true,
    };
  }
  // Disconnected — a local queue with nothing lit. Keep the tick so an offline
  // send can still be logged; the eyebrow + (on social surfaces) hiding the bar
  // is what stops it reading as a directive.
  return {
    tier: 'resume',
    eyebrow: { kind: 'upNext', name: null },
    showTick: true,
  };
}
