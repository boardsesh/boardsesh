// Collapse state for the beta-video shelves. Every surface that renders a row
// of `BetaVideoCard`s — the home shelf, the play-drawer section, "Beta from this
// crew" on session detail, and the profile shelf — shares this one key, so
// folding the row away in one place folds it everywhere (issue #4229).
//
// Backed by the existing `section-expand-store` map rather than a store of its
// own: that store is already a single `Record<string, boolean>` behind one
// AsyncStorage slot, so an extra key costs no extra read, write, or subscription.

import { useCallback } from 'react';
import { hapticSelection } from './haptics';
import { setSectionExpanded, useSectionExpanded } from './section-expand-store';

/** Shared across all four beta shelves. Sits alongside the climb-card section
 *  keys (`logbook`, `boardseshGrade`, `community`, `similarClimbs`) in the same map. */
export const BETA_SHELF_SECTION_KEY = 'betaVideos';

/** Expanded until the user says otherwise — adding a disclosure must not hide
 *  content from climbers who were happy with the shelf. */
export const BETA_SHELF_DEFAULT_EXPANDED = true;

export type BetaShelfCollapse = {
  expanded: boolean;
  toggle: () => void;
};

/**
 * Reads and toggles the shared beta-shelf expand state.
 *
 * No local mirror state: `setSectionExpanded` notifies synchronously and the
 * store is read through `useSyncExternalStore`, so every mounted shelf
 * re-renders on the same tick as the tap. (`CollapsibleSection` keeps a mirror
 * only because it also has to service `defaultExpanded`/`resetKey` and drive a
 * Reanimated shared value from the reconciliation.)
 */
export function useBetaShelfCollapse(): BetaShelfCollapse {
  const { expanded: persisted } = useSectionExpanded(BETA_SHELF_SECTION_KEY);
  const expanded = persisted ?? BETA_SHELF_DEFAULT_EXPANDED;

  const toggle = useCallback(() => {
    hapticSelection();
    setSectionExpanded(BETA_SHELF_SECTION_KEY, !expanded);
  }, [expanded]);

  return { expanded, toggle };
}
