/**
 * Which version of a climb a tick belongs to (#6023).
 *
 * A published climb can be edited. Each tick stores the version it was logged
 * on (`climbRevision`), and each climb carries the version it is on now
 * (`revisionNumber`) and the version at which its holds last moved
 * (`holdsRevisionNumber`). Versions start at 1.
 *
 * Two questions, with different answers for a missing number:
 *
 * - "Does this tick still count as a send of the climb?" follows the server's
 *   rule in `packages/db/src/queries/climb-stats/holds-epoch.ts`, where a
 *   missing number is version 1 on both sides.
 * - "Should the row say it was an earlier version?" needs both numbers to be
 *   known. A tag printed on a guess would be wrong more often than it helps.
 */

type RevisionNumber = number | null | undefined;

/** A stored version number, or null when the value is missing or not a positive integer. */
export function knownClimbRevision(revision: RevisionNumber): number | null {
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : null;
}

/**
 * True when the tick was logged on the holds the climb has now, so it still
 * counts toward "sent" and "attempted". A missing number on either side reads
 * as version 1: a tick with none is an import or older than the field, and a
 * climb with none has not been delivered with it yet. On a climb whose holds
 * never moved this is true for every tick.
 */
export function isTickOnCurrentHolds(tickRevision: RevisionNumber, holdsRevisionNumber: RevisionNumber): boolean {
  return (knownClimbRevision(tickRevision) ?? 1) >= (knownClimbRevision(holdsRevisionNumber) ?? 1);
}

/**
 * True when the tick is known to have been logged on a version of the climb
 * older than the one it is on now. False whenever either number is missing.
 * Any edit counts, a rename included: this drives the "Earlier version" tag,
 * which says the climb has changed since, not that the send no longer counts.
 */
export function isTickOnEarlierVersion(tickRevision: RevisionNumber, climbCurrentRevision: RevisionNumber): boolean {
  const tick = knownClimbRevision(tickRevision);
  const current = knownClimbRevision(climbCurrentRevision);
  return tick !== null && current !== null && tick < current;
}
