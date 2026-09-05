import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { useCallback, useRef } from 'react';
import { useRouter } from 'expo-router';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { captureToSentry } from '../../lib/sentry';

export type DismissSurfaceAndWait = () => Promise<DismissAndWaitResult>;

type UseCreateClimbNavigationOptions = {
  /** A native BoardSheet / QueueSheet underneath the actions overlay. */
  dismissSourceSheet?: DismissSurfaceAndWait;
  /** Supplied only by the real `/play` route. iPad panes deliberately omit it. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
};

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
 * A single accepted action owns the whole handoff: dismiss the custom actions overlay,
 * await any source native sheet, await the `/play` native-stack closing transition, then
 * push create. CreateDrawer intentionally remains outside the sheet coordinator, so the
 * two preceding surfaces must be physically gone before its first render presents it.
 */
export function useCreateClimbNavigation({
  dismissSourceSheet,
  dismissPlayerAndWait,
}: UseCreateClimbNavigationOptions = {}) {
  const router = useRouter();
  const dismissSourceSheetRef = useRef(dismissSourceSheet);
  dismissSourceSheetRef.current = dismissSourceSheet;
  const dismissPlayerAndWaitRef = useRef(dismissPlayerAndWait);
  dismissPlayerAndWaitRef.current = dismissPlayerAndWait;
  // The actions overlay remains hit-testable during its short exit animation. Claim the
  // action synchronously, before asking it to animate out, so a double tap cannot enqueue
  // two native dismissals or two create routes.
  const actionInFlightRef = useRef(false);
  const resetActionGuard = useCallback(() => {
    actionInFlightRef.current = false;
  }, []);

  const navigateToCreate = useCallback(
    (params: Record<string, string>, onActionAccepted?: () => void) => {
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      onActionAccepted?.();

      const completeHandoff = async () => {
        const dismissSource = dismissSourceSheetRef.current;
        if (dismissSource) {
          const sourceResult = await dismissSource();
          if (sourceResult.status === 'aborted') return;
        }

        const dismissPlayer = dismissPlayerAndWaitRef.current;
        if (dismissPlayer) {
          const playerResult = await dismissPlayer();
          if (playerResult.status === 'aborted') return;
        }

        router.push({ pathname: '/(tabs)/climbs/create', params });
      };
      void completeHandoff().catch((error: unknown) => {
        // The owning overlay is already closing, so keep this presentation's
        // one-action claim intact. A re-open resets the guard (or remounts this
        // hook), while the failed route transition still reaches diagnostics.
        captureToSentry(error, {
          level: 'error',
          tags: { source: 'create-climb-handoff' },
        });
      });
    },
    [router],
  );

  const openRemix = useCallback(
    (climb: Climb, board: BoardConfig, onActionAccepted?: () => void) =>
      navigateToCreate(
        {
          forkFrames: climb.frames,
          forkName: climb.name,
          forkDescription: climb.description ?? '',
          // Carry the source's climb rules across (#4832) — a remix that silently
          // dropped "no matching" or "any feet" published a different climb from
          // the one it was remixed from. Serialised only when the source actually
          // HAS an array: an absent param is what tells the editor to fall back
          // to the legacy `No match` description prefix, and `"[]"` (a source
          // whose rules are all at their defaults) must not read as absent.
          ...(climb.characteristics ? { forkCharacteristics: JSON.stringify(climb.characteristics) } : {}),
          ...boardParams(resolveClimbRenderBoard(climb, board)?.boardConfig ?? board),
        },
        onActionAccepted,
      ),
    [navigateToCreate],
  );

  const openEdit = useCallback(
    (climb: Climb, board: BoardConfig, onActionAccepted?: () => void) =>
      navigateToCreate(
        {
          editClimbUuid: climb.uuid,
          ...boardParams(resolveClimbRenderBoard(climb, board)?.boardConfig ?? board),
        },
        onActionAccepted,
      ),
    [navigateToCreate],
  );

  // Only the semantic wrappers are exposed. A caller cannot hand-roll params or bypass
  // the one-action / source-sheet / player-transition ordering above.
  return { openRemix, openEdit, resetActionGuard };
}
