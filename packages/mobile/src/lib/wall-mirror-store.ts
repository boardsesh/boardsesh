import { useSyncExternalStore } from 'react';

/**
 * The solo mirror flip for the climb on the wall (#6940): which climb it was
 * tapped on and which way round. The player and the MiniPlayer both read it and
 * both write it, so a tap on either one shows on the other.
 *
 * It is the reactive copy of the BLE provider's mirror intent
 * (`setMirrorIntent` / `retainMirrorIntentFor`), which is a ref and so cannot
 * re-render anyone. Every write goes through the two functions below, which
 * update this slot and the provider together, so the button state and what the
 * auto-sender lights can't drift apart.
 *
 * The rules are the provider's own:
 *  - One slot. A tap on another climb takes it over.
 *  - The player calls `retainWallMirrorFlip` as it settles on a committed solo
 *    climb, which drops a flip parked on any other climb. Nothing else clears
 *    it, so a flip survives the player closing, a preview, and a reopen on the
 *    same climb (the player is a route on iPhone).
 *  - A shared session ignores it: the crew's orientation is the queue item's
 *    `climb.mirrored`, changed through `mirrorCurrentClimb`.
 *
 * A preview's flip is NOT here. Mirroring a climb you are only looking at must
 * not touch the wall, so the player keeps that one in its own state.
 *
 * A module store (not context) because the MiniPlayer and the player sit in
 * different branches of the root, and the player is not mounted while closed.
 */

export type WallMirrorFlip = { climbUuid: string; mirrored: boolean };

/** The BLE provider's two mirror-intent calls (`useOptionalBluetoothContext`), or nothing without one. */
type MirrorIntentSink =
  | {
      setMirrorIntent: (climbUuid: string, mirrored: boolean) => void;
      retainMirrorIntentFor: (climbUuid: string | undefined) => void;
    }
  | null
  | undefined;

let wallMirrorFlip: WallMirrorFlip | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WallMirrorFlip | null {
  return wallMirrorFlip;
}

export function getWallMirrorFlip(): WallMirrorFlip | null {
  return wallMirrorFlip;
}

/** A tap on the climb on the wall, solo: flip it, here and for the auto-sender. */
export function setWallMirrorFlip(bluetooth: MirrorIntentSink, climbUuid: string, mirrored: boolean): void {
  if (wallMirrorFlip?.climbUuid !== climbUuid || wallMirrorFlip.mirrored !== mirrored) {
    wallMirrorFlip = { climbUuid, mirrored };
    notify();
  }
  bluetooth?.setMirrorIntent(climbUuid, mirrored);
}

/** Forget a flip made on any climb but this one; keep one made on this one. */
export function retainWallMirrorFlip(bluetooth: MirrorIntentSink, climbUuid: string | undefined): void {
  if (wallMirrorFlip != null && wallMirrorFlip.climbUuid !== climbUuid) {
    wallMirrorFlip = null;
    notify();
  }
  bluetooth?.retainMirrorIntentFor(climbUuid);
}

/** The whole slot. Compare its `climbUuid` before reading `mirrored`. */
export function useWallMirrorFlip(): WallMirrorFlip | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** The flip tapped on this climb, or `undefined` when nobody tapped it (not the same as un-mirrored). */
export function wallMirrorFlipFor(flip: WallMirrorFlip | null, climbUuid: string | undefined): boolean | undefined {
  return flip != null && climbUuid !== undefined && flip.climbUuid === climbUuid ? flip.mirrored : undefined;
}

export function __resetWallMirrorFlipForTests(): void {
  wallMirrorFlip = null;
  notify();
}
