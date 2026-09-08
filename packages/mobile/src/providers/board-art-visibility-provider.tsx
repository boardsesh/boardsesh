import { type ReactNode } from 'react';
import { useSegments } from 'expo-router';
import { BoardArtVisibilityContext } from '../components/board-art-visibility-context';
import { useDeviceLayout } from '../hooks/use-device-layout';
import { tabsActiveSegment } from '../lib/route-segments';

// The top-level tab names ((tabs)/<name>). Typing the `tab` prop as this union
// (not a bare string) makes a typo in a layout's `tab="…"` a compile error rather
// than a tab that silently reports hidden forever on iPad.
export type BoardArtTab = 'climbs' | 'discover' | 'home' | 'profile' | 'record' | 'wall';

/**
 * Releases board art in non-focused iPad tabs. The iPad shell keeps every tab
 * mounted (`detachInactiveScreens={false}`), so hidden image views would retain
 * decoded bitmaps for the life of the session. Clearing the image cache only
 * releases cache copies, not bitmaps a mounted view still holds (#3803).
 *
 * Phones keep their images mounted through navigation. The player has an opaque
 * backing, but its opening/closing animations reveal the list beneath it. During
 * swipe dismissal `/play` stays focused until the player is offscreen, so hiding
 * on route focus would expose blank thumbnails while their images reload.
 * App-background cleanup remains owned by LayeredClimbImage on every device.
 */
export function BoardArtVisibilityProvider({ tab, children }: { tab: BoardArtTab; children: ReactNode }) {
  const { isPad } = useDeviceLayout();
  const segments = useSegments();
  // On iPad, visible only while THIS tab is the focused top-level destination
  // (segment 1). A pushed sub-route of the tab keeps it active (`tabsActiveSegment`
  // still returns the tab name). The value is a primitive boolean, so the provider
  // needs no memo (react/jsx-no-constructed-context-values).
  const visible = !isPad || tabsActiveSegment(segments) === tab;
  return <BoardArtVisibilityContext.Provider value={visible}>{children}</BoardArtVisibilityContext.Provider>;
}
