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
 * is trusted whenever `characteristics` is absent, even if a description is
 * present: the stubs built from a feed item or a tick carry a description but
 * never the characteristics, so re-deriving from the prose alone misses a
 * climb marked no-match by its characteristic and every MoonBoard/Woods/spray
 * climb.
 *
 * DB rows have no `is_no_match` column and always project characteristics, so
 * they never reach that branch. When characteristics are present the value is still
 * recomputed (the #5127 trailing-prose fix keeps applying). The result is a
 * display badge, and a queue client already controls name, grade and frames.
 */
export function resolveClimbNoMatchField(parent: ClimbNoMatchParent): boolean {
  if (parent.characteristics == null && typeof parent.is_no_match === 'boolean') {
    return parent.is_no_match;
  }
  return resolveClimbNoMatch(parent.boardType, parent.characteristics, parent.description);
}
