// The archive readers for the spray registry (`docs/spray-walls.md`, "Archive
// and reset").
//
// Registry-only on purpose, unlike `use-spray-wall.ts`, which also wires up the
// network loader: these are read on list rows, the board sheet, the climb
// actions and the create route, none of which should pull the GraphQL client in
// just to ask whether a wall is archived.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  ensureSprayWallLoaded,
  getSprayWallLoadState,
  sprayWallArchiveState,
  sprayWallHiddenAt,
  subscribeToSprayWalls,
  type SprayWallArchiveState,
} from './spray-wall-registry';

/**
 * The archive and hold-lock state of the wall behind a board config, or `null`
 * on every catalogue board and until the wall has registered.
 *
 * Asks for the wall too, like the readers in `use-spray-wall.ts`, so a wall archived from
 * another device is seen once its registration is past the revalidation
 * window. Safe per row: the snapshot is the registry's own object, which keeps
 * its identity until the state really changes.
 */
export function useSprayWallArchiveState(
  boardName: string | null | undefined,
  layoutId: number | null,
): SprayWallArchiveState | null {
  const sprayLayoutId = boardName === 'spray' ? layoutId : null;
  useEffect(() => {
    if (sprayLayoutId != null) ensureSprayWallLoaded(sprayLayoutId);
  }, [sprayLayoutId]);
  return useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (sprayLayoutId == null ? null : sprayWallArchiveState('spray', sprayLayoutId)), [sprayLayoutId]),
  );
}

/** Whether the wall behind a board config is archived. `false` on every catalogue board and until it registers. */
export function useSprayWallIsArchived(boardName: string | null | undefined, layoutId: number | null): boolean {
  return useSprayWallArchiveState(boardName, layoutId)?.archivedAt != null;
}

/**
 * When an admin hid the wall behind a board config, or null. Only ever set for
 * the wall's owner (`SprayWall.hiddenAt` resolves for nobody else).
 */
export function useSprayWallHiddenAt(boardName: string | null | undefined, layoutId: number | null): string | null {
  const sprayLayoutId = boardName === 'spray' ? layoutId : null;
  return useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (sprayLayoutId == null ? null : sprayWallHiddenAt('spray', sprayLayoutId)), [sprayLayoutId]),
  );
}

/**
 * Whether the wall behind a board config has answered for its archive state:
 * true once it registered (its archive state is then known, or read as live
 * when the archive query failed), and true once its load settled without it
 * (an unknown wall is not archived). Always true off a spray board.
 */
export function useSprayWallArchiveSettled(boardName: string | null | undefined, layoutId: number | null): boolean {
  const sprayLayoutId = boardName === 'spray' ? layoutId : null;
  useEffect(() => {
    if (sprayLayoutId != null) ensureSprayWallLoaded(sprayLayoutId);
  }, [sprayLayoutId]);
  return useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => {
      if (sprayLayoutId == null) return true;
      const state = getSprayWallLoadState(sprayLayoutId);
      return state === 'ready' || state === 'unavailable';
    }, [sprayLayoutId]),
  );
}
