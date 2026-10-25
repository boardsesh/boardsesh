import { resolveClimbNoMatch } from '../shared/helpers';

type ClimbNoMatchParent = {
  characteristics?: readonly string[] | null;
  description?: string | null;
  boardType?: string | null;
  is_no_match?: boolean | null;
};

/**
 * `Climb.is_no_match`. Derived from characteristics and description for every
 * producer, with one exception: a client-supplied queue `ClimbInput` stub (a
 * tick or proposal row queued from the logbook) carries the flag the client
 * already resolved but neither input. Re-deriving there returned false and
 * stripped the glyph from every peer's copy (#6681), so the parent's boolean
 * is trusted only when both inputs are absent. An empty description counts as
 * absent: `ClimbInputSchema` turns a missing one into '' before it is stored.
 *
 * DB rows have no `is_no_match` column and always project characteristics, so
 * they never reach that branch. When either input is present the value is still
 * recomputed (the #5127 trailing-prose fix keeps applying). The result is a
 * display badge, and a queue client already controls name, grade and frames.
 */
export function resolveClimbNoMatchField(parent: ClimbNoMatchParent): boolean {
  if (parent.characteristics == null && !parent.description && typeof parent.is_no_match === 'boolean') {
    return parent.is_no_match;
  }
  return resolveClimbNoMatch(parent.boardType, parent.characteristics, parent.description);
}
