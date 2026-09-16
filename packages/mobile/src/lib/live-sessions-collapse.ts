// Collapse state for Home's "Climbing now" rail. A sibling of
// `beta-shelf-collapse.ts`, backed by the same `section-expand-store` map: one
// AsyncStorage slot, one read, one subscription for every collapsible section.

import { useCallback } from 'react';
import { hapticSelection } from './haptics';
import { setSectionExpanded, useSectionExpanded } from './section-expand-store';

export const LIVE_SESSIONS_SECTION_KEY = 'liveSessions';

/** Expanded until the climber folds it away. */
export const LIVE_SESSIONS_DEFAULT_EXPANDED = true;

export type LiveSessionsCollapse = {
  expanded: boolean;
  toggle: () => void;
  /** False until the stored value has been read; render neither state before then. */
  loaded: boolean;
};

export function useLiveSessionsCollapse(): LiveSessionsCollapse {
  const { expanded: persisted, loaded } = useSectionExpanded(LIVE_SESSIONS_SECTION_KEY);
  const expanded = persisted ?? LIVE_SESSIONS_DEFAULT_EXPANDED;

  const toggle = useCallback(() => {
    hapticSelection();
    setSectionExpanded(LIVE_SESSIONS_SECTION_KEY, !expanded);
  }, [expanded]);

  return { expanded, toggle, loaded };
}
