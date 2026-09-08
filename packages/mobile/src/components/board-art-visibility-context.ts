import { createContext, useContext } from 'react';

// Whether board art in this subtree is on a currently-visible surface. Default
// `true`, so board art rendered outside a provider — the iPad sidebar cell +
// play pane, root player, and unit tests — always paints while foregrounded.
//
// A per-tab `BoardArtVisibilityProvider` flips this to `false` for an INACTIVE
// iPad tab. The iPad shell keeps every tab mounted (`detachInactiveScreens={false}`
// for the #3153 re-attach cost), so an off-screen tab's `LayeredClimbImage` views
// otherwise pin their decoded board-art bitmaps for the whole session — and
// `Image.clearMemoryCache()` can't reclaim a bitmap a mounted view still retains,
// only unreferenced cache copies. Left unbounded across a multi-day foreground
// session, that is the iPad image-memory growth behind #3803. LayeredClimbImage
// reads this and drops its `<Image>` layers when hidden (the same lever it uses on
// app-background), re-decoding from the disk cache in tens of ms on return.
export const BoardArtVisibilityContext = createContext<boolean>(true);

export function useBoardArtVisible(): boolean {
  return useContext(BoardArtVisibilityContext);
}
