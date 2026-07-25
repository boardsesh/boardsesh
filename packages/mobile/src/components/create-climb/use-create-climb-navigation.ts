import { useCallback, useRef } from 'react';
import { useRouter, useSegments } from 'expo-router';
import type { Climb } from '@boardsesh/shared-schema';
import { isPlayerRoute } from '../../lib/route-segments';
import type { BoardConfig } from '../../providers/drawer-host-provider';

/** expo-router params are strings; the create route reads them via `useLocalSearchParams`. */
function boardParams(board: BoardConfig): Record<string, string> {
  return {
    boardName: board.boardName,
    layoutId: String(board.layoutId),
    sizeId: String(board.sizeId),
    setIds: board.setIds,
    angle: String(board.angle),
  };
}

/**
 * Navigation to the create-climb route (`/(tabs)/climbs/create`) for remix / edit.
 *
 * Remix and Edit can fire from INSIDE the player (`/play`, a `transparentModal` in the
 * ROOT stack). The create route is another `transparentModal`, but it lives in the
 * CLIMBS-TAB stack — a different navigator, mounted BENEATH the root modal. Pushing it
 * while the player is up therefore stacks create under the still-live player: two
 * drawers, and create's bottom sheet strands over the search list once you navigate
 * away. So dismiss the player first, mirroring `handleSwitchBoardFromDrawer`
 * (drawer-host-provider) — the same `router.dismiss()` → `router.push()` shape.
 *
 * The reaction menu that hosts Remix/Edit also opens from the climbs list and the board
 * sheet, and on an iPad regular-width layout the player renders in the detail PANE
 * rather than the `/play` route. Neither has a modal to close, so gate the dismiss on
 * `isPlayerRoute` — otherwise we'd pop the wrong screen.
 */
export function useCreateClimbNavigation() {
  const router = useRouter();
  const segments = useSegments();
  // `useSegments()` hands back a fresh array on every navigation. Reading it from a ref
  // inside the callback — rather than listing it as a dep — keeps `navigateToCreate` /
  // `openRemix` / `openEdit` referentially stable, so `useClimbActions`' memoised action
  // list doesn't rebuild on every navigation. Only ever read from an event handler, well
  // after render, so the ref is never stale at the point of use.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const navigateToCreate = useCallback(
    (params: Record<string, string>) => {
      if (isPlayerRoute(segmentsRef.current)) router.dismiss();
      router.push({ pathname: '/(tabs)/climbs/create', params });
    },
    [router],
  );

  const openRemix = useCallback(
    (climb: Climb, board: BoardConfig) =>
      navigateToCreate({
        forkFrames: climb.frames,
        forkName: climb.name,
        forkDescription: climb.description ?? '',
        ...boardParams(board),
      }),
    [navigateToCreate],
  );

  const openEdit = useCallback(
    (climb: Climb, board: BoardConfig) =>
      navigateToCreate({
        editClimbUuid: climb.uuid,
        ...boardParams(board),
      }),
    [navigateToCreate],
  );

  return { navigateToCreate, openRemix, openEdit };
}
