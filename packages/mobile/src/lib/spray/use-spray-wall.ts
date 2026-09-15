// The React side of the spray registry.
//
// `useSprayWallLoader()` wires `ensureSprayWallLoaded` up to the network once,
// at the app root. `useSprayWall(layoutId)` asks for one wall and re-renders when
// it lands.
//
// Neither owns a query of its own any more: the fetching lives in
// `spray-wall-loader.ts` so that a wall resolved WITHOUT a hook — a queue item
// set on another wall, a playlist row, `resolveClimbRenderBoard` falling a climb
// back onto its own board — reaches the same deduped request and the same
// registry entry. A hook that fetched privately would leave those surfaces
// drawing a placeholder forever.
//
// The photo URLs are the reason nothing is persisted. `SprayWallPhoto.url` is a
// signature over an object in the PRIVATE bucket (`docs/spray-walls.md`, "Photos
// and privacy"), so the query refetches rather than storing it, and the local
// copy on disk is keyed on `(layoutId, version)` instead — see
// `spray-photo-cache.ts`.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ensureSprayWallLoaded,
  getSprayWallLoadState,
  subscribeToSprayWalls,
  type SprayWallLoadState,
} from './spray-wall-registry';
import { installSprayWallLoader } from './spray-wall-loader';

export {
  sprayWallByLayoutQueryKey,
  sprayWallRenderDataQueryKey,
  WALL_IDENTITY_STALE_TIME_MS,
  RENDER_DATA_STALE_TIME_MS,
} from './spray-wall-loader';

/**
 * Give the registry a way to fetch. Mount once, above every board surface.
 *
 * Without it `ensureSprayWallLoaded` is inert and only walls asked for by
 * `useSprayWall` arrive — which is exactly the active-board-only behaviour this
 * replaced.
 */
export function useSprayWallLoader(): void {
  const queryClient = useQueryClient();
  useEffect(() => installSprayWallLoader(queryClient), [queryClient]);
}

export type UseSprayWallResult = {
  /** The wall has not resolved either way yet. */
  isLoading: boolean;
  /**
   * The wall resolved but cannot be drawn: it does not exist, the viewer may not
   * see it, nothing is published, no readable photo, a photo that will not say
   * its pixel size, or a singular homography. The board surface shows its
   * placeholder either way; this is the flag a screen would read to say so in
   * words.
   */
  isUnrenderable: boolean;
  /** The raw state, for a caller that wants to tell `idle` from `loading`. */
  loadState: SprayWallLoadState;
};

/**
 * Ask for one wall and re-render when the answer lands.
 *
 * `layoutId: null` is a no-op, so a surface can call this unconditionally while
 * its board config resolves.
 */
export function useSprayWall(layoutId: number | null): UseSprayWallResult {
  const loadState = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (layoutId == null ? 'idle' : getSprayWallLoadState(layoutId)), [layoutId]),
  );

  useEffect(() => {
    if (layoutId == null) return;
    ensureSprayWallLoaded(layoutId);
    // Deliberately NOT unregistered on unmount. The registry is session state,
    // not screen state: a queue thumbnail, a play drawer and a list row all draw
    // the same wall from it, and tearing it down when one of them unmounts would
    // blank the others. It is withdrawn when the wall itself goes away.
  }, [layoutId, loadState]);

  return {
    isLoading: loadState === 'idle' || loadState === 'loading',
    isUnrenderable: loadState === 'unavailable',
    loadState,
  };
}
