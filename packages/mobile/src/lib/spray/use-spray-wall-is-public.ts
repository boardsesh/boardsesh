import { useCallback, useSyncExternalStore } from 'react';
import { getSprayWall, subscribeToSprayWalls } from './spray-wall-registry';

/**
 * Whether the registered Spraywall on this layout is public, as its last load
 * said. False off spray (`layoutId` null), before the wall loads, and for a
 * wall without share flags: a caller only uses it to decide whether to say
 * something, so unknown reads as "no".
 */
export function useSprayWallIsPublic(layoutId: number | null): boolean {
  return useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (layoutId == null ? false : getSprayWall(layoutId)?.share?.isPublic === true), [layoutId]),
  );
}
