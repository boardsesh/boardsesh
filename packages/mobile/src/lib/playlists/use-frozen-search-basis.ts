import { useCallback, useRef } from 'react';

/**
 * Holds the search a swipe track pages against, frozen at the moment the climber
 * selected a climb from the list (issue #5402).
 *
 * The swipe track is "list-first" (#4829): tapping a row captures the current
 * search results and next/previous walk that order. Paging the rest of it against
 * the LIVE search is what breaks that promise, because two ordinary things move
 * the list out from under a track already being walked:
 *
 *  - Logging a send bumps the climb's `ascensionist_count` and invalidates
 *    `['searchClimbs']` / `['infiniteSearchClimbs']`, which reorders the default
 *    `ascents desc` sort. On a low-ascent board one send moves a climb several
 *    places.
 *  - The climber changes a filter with the play drawer still open.
 *
 * Paging is by offset, so a page fetched after either one comes from a different
 * ordering than the pages already in the track. Duplicates are caught downstream by
 * the drain's uuid dedupe; a climb that moved to an EARLIER page is simply skipped,
 * and nothing notices.
 *
 * The rule this encodes: the track is captured when the climber selects something,
 * and only the next selection may re-derive it. The visible list is untouched — it
 * should still refetch and reorder after a send.
 *
 * `read()` falls back to the live value until the first `capture()`, so a caller
 * that pages without a preceding selection still gets a sensible search.
 */
export type FrozenSearchBasis<TBasis> = {
  /** Call at the moment of selection. The next `read()` returns this snapshot. */
  capture: () => void;
  /** The frozen basis, or the live one when nothing has been captured yet. */
  read: () => TBasis;
};

export function useFrozenSearchBasis<TBasis>(liveBasis: TBasis): FrozenSearchBasis<TBasis> {
  // Assigned during render, not in an effect: a selection can capture in the same
  // commit that a page fetch starts, and an effect would leave one render where
  // the snapshot is a frame behind the list the climber actually tapped.
  const liveRef = useRef(liveBasis);
  liveRef.current = liveBasis;
  const frozenRef = useRef<{ basis: TBasis } | null>(null);

  const capture = useCallback(() => {
    frozenRef.current = { basis: liveRef.current };
  }, []);
  const read = useCallback(() => frozenRef.current?.basis ?? liveRef.current, []);

  // Wrapped in a ref-backed object rather than a memo so the identity is stable
  // for the lifetime of the screen; `fetchSearchPage` depends on it and must not
  // churn on every keystroke in the search box.
  const apiRef = useRef<FrozenSearchBasis<TBasis>>({ capture, read });
  return apiRef.current;
}
