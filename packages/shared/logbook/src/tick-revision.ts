/**
 * Which version of a climb a tick belongs to (#6023).
 *
 * Each tick stores the version it was logged on (`climbRevision`, picked by
 * the server), and each climb carries the version at which its holds last
 * moved (`holdsRevisionNumber`). Versions start at 1.
 *
 * "Does this tick still count as a send of the climb?" follows the rule the
 * server used to apply, where a tick with no version is version 1. The server
 * dropped the rule and no longer moves either number, so every climb's holds
 * version is 1 and every tick counts. A tick the app cannot say anything about
 * is a third case and counts (see `isTickOnCurrentHolds`).
 */

type RevisionNumber = number | null | undefined;

/** A stored version number, or null when the value is missing or not a positive integer. */
export function knownClimbRevision(revision: RevisionNumber): number | null {
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : null;
}

/**
 * True when the tick was logged on the holds the climb has now, so it still
 * counts toward "sent" and "attempted".
 *
 * The tick's version has three states, and the last two are different:
 *
 * - a number: that version.
 * - `null`: the tick is known to carry no version. It is an import or older
 *   than the field, both logged before any climb had been edited, so it reads
 *   as version 1. This is the server's rule.
 * - `undefined`: the app does not know whether the tick has a version. Its row
 *   came from a document that cannot select the field and the phone holds no
 *   copy of the tick to ask. The tick COUNTS. Reading it as version 1 would
 *   turn a send on the current holds into "not sent" for as long as the phone
 *   had not pulled it.
 *
 * A climb with no holds version reads as version 1: it has not been delivered
 * with the number yet, and every tick counts on it as it did before the field.
 */
export function isTickOnCurrentHolds(tickRevision: RevisionNumber, holdsRevisionNumber: RevisionNumber): boolean {
  if (tickRevision === undefined) return true;
  return (knownClimbRevision(tickRevision) ?? 1) >= (knownClimbRevision(holdsRevisionNumber) ?? 1);
}
