import { createHash } from 'crypto';

/**
 * Compute the canonical hold fingerprint for a climb. The dedup path uses
 * this as the lookup key on (board_type, layout_id, hold_fingerprint) —
 * two climbs with the same fingerprint at the same layout are duplicates
 * and the second one becomes an alias of the first.
 *
 * Same algorithm the backfill script uses
 * (packages/db/scripts/backfill-hold-fingerprints.ts), and the same
 * algorithm a future Kilter-style fingerprint check must use. Keep these
 * three sites in sync — if you tune one, tune them all, otherwise the
 * dedup hash space splits and aliases stop pointing where they should.
 */
export type HoldTuple = {
  holdId: number;
  frameNumber: number;
  holdState: string;
};

export function fingerprintFromHolds(holds: HoldTuple[]): string {
  const tuples = holds
    .map((h) => `${h.holdId}:${h.holdState}:${h.frameNumber}`)
    .sort()
    .join('|');
  return createHash('sha256').update(tuples).digest('hex');
}
