import { favoritesStore } from '@boardsesh/climb-actions';

/**
 * Tracks which favourite toggle is the newest per climb, so a slow failure
 * can't roll back over a newer tap's result.
 *
 * Comparing values instead is NOT enough, which is the subtle part: tap 1 (add)
 * optimistically writes `true`; tap 2 (remove) writes `false`; tap 2 fails and
 * rolls back to `true`. Now tap 1 fails, sees `true` — its own optimistic value —
 * and "correctly" rolls back to `false`, landing the heart on the state of the
 * older attempt. Identity, not equality, is what decides who owns the rollback.
 */
export class FavoriteToggleOrder {
  private latest = new Map<string, number>();
  private counter = 0;

  /** Claim ownership of a climb's state for a new toggle; returns its token. */
  begin(climbUuid: string): number {
    this.counter += 1;
    this.latest.set(climbUuid, this.counter);
    return this.counter;
  }

  /** Whether this toggle is still the newest one for the climb. */
  isLatest(climbUuid: string, token: number): boolean {
    return this.latest.get(climbUuid) === token;
  }

  /** Release ownership once a toggle settles, so the map doesn't grow with the
   *  session. A superseded toggle leaves the newer one's entry alone. */
  settle(climbUuid: string, token: number): void {
    if (this.latest.get(climbUuid) === token) this.latest.delete(climbUuid);
  }
}

export const favoriteToggleOrder = new FavoriteToggleOrder();

/**
 * Whether a settling favourite toggle may still write to the shared store: it
 * must be the newest toggle for that climb AND the store must still be scoped
 * to the context the toggle started in (board + angle + user). Both toggle
 * mutations write the same singleton, so both ask this rather than each
 * re-deriving half of it.
 */
export function ownsFavoriteWrite(climbUuid: string, context: { token: number; contextEpoch: number }): boolean {
  if (favoritesStore.getContextEpoch() !== context.contextEpoch) return false;
  return favoriteToggleOrder.isLatest(climbUuid, context.token);
}
