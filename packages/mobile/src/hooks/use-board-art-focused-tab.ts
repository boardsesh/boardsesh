import { useState } from 'react';
import { useSegments } from 'expo-router';
import { boardArtFocusedTab, tabsActiveSegment } from '../lib/route-segments';

/**
 * The tab whose board art is on screen: the focused tab, or under the player
 * the tab it opened over (see `boardArtFocusedTab`). Both the iPad board-art
 * visibility and the iPad image-cache sweep read this, so a player visit is
 * neither a hidden tab nor a tab switch to either of them.
 *
 * The previous answer is kept in state and moved during render, React's
 * pattern for state derived from the last props, so a render that never
 * commits cannot leave a wrong tab behind.
 */
export function useBoardArtFocusedTab(): string | null {
  const segments = useSegments();
  const [previousTab, setPreviousTab] = useState<string | null>(() => tabsActiveSegment(segments));
  const focusedTab = boardArtFocusedTab(segments, previousTab);
  if (focusedTab !== previousTab) setPreviousTab(focusedTab);
  return focusedTab;
}
