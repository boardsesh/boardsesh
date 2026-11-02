/**
 * Where a wall confirm came from.
 *
 * - `'self'`: this phone's own link lit the climb (the Bluetooth provider's
 *   write or its auto-sender's success).
 * - `'relay'`: heard from someone else's report, such as the session feed's
 *   `WallConfirmedClimb`. That feed carries every member's confirm, this
 *   phone's own echo included, so a relay never proves this phone lit anything.
 */
export type WallConfirmOrigin = 'self' | 'relay';

export type WallConfirmListener = (climbUuid: string, origin: WallConfirmOrigin) => void;

const wallConfirmListeners = new Set<WallConfirmListener>();

/** Every listener hears every confirm, whatever its origin; one that cares filters on `origin`. */
export function subscribeToWallConfirm(callback: WallConfirmListener): () => void {
  wallConfirmListeners.add(callback);
  return () => {
    wallConfirmListeners.delete(callback);
  };
}

export function emitWallConfirm(climbUuid: string, origin: WallConfirmOrigin): void {
  for (const listener of wallConfirmListeners) {
    try {
      listener(climbUuid, origin);
    } catch (error) {
      console.error('wall-confirm listener threw:', error);
    }
  }
}
