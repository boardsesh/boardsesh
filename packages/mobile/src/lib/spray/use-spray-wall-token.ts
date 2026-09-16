// The one-line subscription a SYNCHRONOUS board surface needs.
//
// `getBoardRenderData` answers null for a wall the registry has not got, and a
// component that gates on that answer returns BEFORE it mounts anything that
// subscribes to the registry — `BoardImageNative`, and the `useSyncExternalStore`
// inside `useNativeClimbRender`. So when the wall lands, `notify()` has nothing
// to re-render: the component's props have not moved, its memo holds, and it
// stays on its placeholder until something unrelated changes.
//
// Calling this FIRST, above every early return, fixes both halves at once: it
// asks for the wall and it subscribes, so the arrival re-renders the component
// that was waiting for it. One Map lookup per render; `''` for every catalogue
// board, so a non-spray surface pays a string comparison and nothing else.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ensureSprayWallLoaded, sprayCacheToken, subscribeToSprayWalls } from './spray-wall-registry';

/**
 * Subscribe to one wall's cache token, requesting the wall if it is not held.
 *
 * Returns the token (`''` off spray), which callers can ignore — the value is
 * there for a surface that wants it in a memo dependency, and the re-render is
 * the point.
 */
export function useSprayWallToken(boardName: string | null | undefined, layoutId: number | null | undefined): string {
  const isSpray = boardName === 'spray' && typeof layoutId === 'number';

  const token = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (isSpray ? sprayCacheToken('spray', layoutId as number) : ''), [isSpray, layoutId]),
  );

  useEffect(() => {
    if (isSpray) ensureSprayWallLoaded(layoutId as number);
  }, [isSpray, layoutId, token]);

  return token;
}
