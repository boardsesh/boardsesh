import { findPlaylistClimbIndex, type PlaylistSuggestionSource } from '@boardsesh/queue';

/**
 * What the player says about the list it is walking: "Projects · 4 of 23"
 * (issue #6664, closing #3841, where a climber swiped expecting the list they
 * had just tapped in and got whatever was queued).
 *
 * - `hidden`: nothing to say. No track, a track nobody named, or the climb on
 *   screen is not on it, which is when navigation has stopped walking it.
 * - `named`: the list's name with no count, because the count is not known or
 *   could be wrong (see `PlaylistSuggestionSource.total`).
 * - `counted`: the name plus a 1-based position and the list's total.
 * - `upNext`: a queued climb plays in the middle of the list (issue #6777), so
 *   the player says "Up next · 1 of 3" until the list picks up again. `count`
 *   is where it sits in that stretch of Up next, null when it can't be counted.
 *   `listName` is the list the walk returns to, null for a list nobody named:
 *   the end card names it when the queue ran out at the list's end.
 */
export type TrackLabelModel =
  | { kind: 'hidden' }
  | { kind: 'named'; name: string }
  | { kind: 'counted'; name: string; position: number; total: number }
  | { kind: 'upNext'; listName: string | null; count: { position: number; total: number } | null };

const HIDDEN: TrackLabelModel = { kind: 'hidden' };

/**
 * The label for `climbUuid` on `source`.
 *
 * `source` must be the track navigation is actually walking, the resolved one
 * (`resolveNavigationSuggestionSource`), never the provider's held track: a
 * held track goes dormant when the climber moves off it, and the player must
 * not name a list its swipes no longer follow.
 *
 * Never prints a wrong number. The position is the climb's index on the track,
 * which is its place in the list only while the track carries a `total`; a
 * position past the total means the two disagree, and the count is dropped.
 */
export function resolveTrackLabel(
  source: PlaylistSuggestionSource | null,
  climbUuid: string | null | undefined,
): TrackLabelModel {
  const name = source?.label?.trim();
  if (!source || !name || !climbUuid) return HIDDEN;
  const index = findPlaylistClimbIndex(source, climbUuid);
  if (index < 0) return HIDDEN;
  const { total } = source;
  const position = index + 1;
  if (total === undefined || !Number.isInteger(total) || total < position) return { kind: 'named', name };
  return { kind: 'counted', name, position, total };
}

/**
 * The label while the walk plays Up next in the middle of `source` (issue
 * #6777). `progress` is `resolveUpNextProgress` for the climb on screen. Shown
 * for a list with no name too: the climber is in their queue either way.
 */
export function resolveUpNextTrackLabel(
  source: PlaylistSuggestionSource | null,
  progress: { position: number; total: number } | null,
): TrackLabelModel {
  return { kind: 'upNext', listName: source?.label?.trim() || null, count: progress };
}

/** The list's name as a label carries it, or null: nothing named, or a list nobody named. */
export function trackLabelListName(model: TrackLabelModel): string | null {
  if (model.kind === 'hidden') return null;
  return model.kind === 'upNext' ? model.listName : model.name;
}
