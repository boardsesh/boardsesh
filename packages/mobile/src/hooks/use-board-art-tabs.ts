import { useState } from 'react';
import { useSegments } from 'expo-router';
import { boardArtFocusedTab, rememberBoardArtTab, tabsActiveSegment } from '../lib/route-segments';

export type BoardArtTabs = {
  /** The tab whose board art is on screen (`boardArtFocusedTab`); `null` for none. */
  focusedTab: string | null;
  /**
   * The last tab the climber was on, kept through every root route
   * (`rememberBoardArtTab`). A change here is a real tab switch.
   */
  rememberedTab: string | null;
};

/**
 * Which tab's board art is on screen, and which tab the climber was last on.
 * The iPad board-art visibility reads the first and the iPad image-cache sweep
 * the second, so a player visit is neither a hidden tab nor a tab switch, even
 * when the player pushes a root page of its own and comes back (#7081).
 *
 * The remembered tab is kept in state and moved during render, React's
 * pattern for state derived from the last props, so a render that never
 * commits cannot leave a wrong tab behind.
 */
export function useBoardArtTabs(): BoardArtTabs {
  const segments = useSegments();
  const [previousTab, setPreviousTab] = useState<string | null>(() => tabsActiveSegment(segments));
  const rememberedTab = rememberBoardArtTab(segments, previousTab);
  if (rememberedTab !== previousTab) setPreviousTab(rememberedTab);
  return { focusedTab: boardArtFocusedTab(segments, rememberedTab), rememberedTab };
}
