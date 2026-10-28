// One-tap Fell / Sent on the MiniPlayer during a timed workout block (#6940).
//
// The bar decides it the way the player does (`shouldShowWorkoutOutcome`), for
// the climb on the wall: the bar always names the committed head, so "the climb
// on screen" is the wall's climb whenever the bar's climb is the head. It holds
// the pair for the climb the wall just left with the player's own hold
// (`useWorkoutOutcomeHold`), so a finger on its way to Fell never lands on Next.
import { useMemo } from 'react';
import { configKey } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/queue';
import { useQueueData, useQueueSessionId } from '../../providers/queue-provider';
import { useAuth } from '../../providers/auth-provider';
import { useWorkoutRun } from '../../lib/workout-run-store';
import { resolveMirroredOrientation } from '../../lib/ble/mirror-orientation';
import { useWallMirrorFlip, wallMirrorFlipFor } from '../../lib/wall-mirror-store';
import type { ClimbRenderBoardResult } from '../../lib/boards/climb-render-board';
import {
  findWorkoutRunStage,
  shouldShowWorkoutOutcome,
  workoutOutcomeAvailable,
  type WorkoutOutcomeTarget,
} from '../play-drawer/workout-outcome';
import { useWorkoutOutcomeHold, type WorkoutOutcomeShown } from '../play-drawer/use-workout-outcome-hold';

export type MiniPlayerWorkoutOutcomeInput = {
  /** The climb the bar names (it can be a retained one through a presence blip). */
  climb: Climb;
  /** The board the bar draws the climb on (`resolveClimbRenderBoard` against the stored board). */
  climbBoard: ClimbRenderBoardResult | null;
  /** Board models standing at this gym: a climb on one of them is a walk, not another board. */
  reachableBoardKeys: ReadonlySet<string> | undefined;
};

export type MiniPlayerWorkoutOutcome = {
  /**
   * The climb on the wall is in a timed block: ⏮ ⏭ stay off the bar, whether
   * or not the climber can log here.
   */
  inTimedBlock: boolean;
  /** Fell / Sent for the climb on the wall, or held for the one it just left. Null otherwise. */
  shown: WorkoutOutcomeShown | null;
};

export function useMiniPlayerWorkoutOutcome({
  climb,
  climbBoard,
  reachableBoardKeys,
}: MiniPlayerWorkoutOutcomeInput): MiniPlayerWorkoutOutcome {
  const { sessionId } = useQueueSessionId();
  const { currentClimbQueueItem } = useQueueData();
  const { isAuthenticated } = useAuth();
  const workoutRun = useWorkoutRun(sessionId);
  const wallMirrorFlip = useWallMirrorFlip();

  const committedQueueItemUuid = currentClimbQueueItem?.uuid ?? null;
  const inTimedBlock = workoutOutcomeAvailable(findWorkoutRunStage(workoutRun, committedQueueItemUuid));
  // The bar names the head, except for a moment through a presence blip.
  const barShowsWall = currentClimbQueueItem !== null && currentClimbQueueItem.climb.uuid === climb.uuid;
  const renderBoard = climbBoard?.boardConfig ?? null;
  // As the player: another board model blocks, unless it stands at this gym.
  const boardMismatch =
    renderBoard === null ||
    (climbBoard?.fit === 'incompatible' &&
      !(
        reachableBoardKeys?.has(configKey({ boardName: renderBoard.boardName, layoutId: renderBoard.layoutId })) ??
        false
      ));
  const canLog = isAuthenticated && !boardMismatch;
  const showLive =
    sessionId !== null &&
    barShowsWall &&
    shouldShowWorkoutOutcome({
      run: workoutRun,
      displayedQueueItemUuid: committedQueueItemUuid,
      committedQueueItemUuid,
      signedIn: isAuthenticated,
      boardMismatch,
      isDraft: climb.is_draft === true,
    });
  const wallClimb = currentClimbQueueItem?.climb ?? null;
  // The orientation the wall shows, as the bar's Log reads it: a crew's is the
  // queue item's, solo it is the wall flip when someone tapped Mirror.
  const isMirror =
    wallClimb === null
      ? false
      : sessionId === null
        ? resolveMirroredOrientation({
            explicitFlip: wallMirrorFlipFor(wallMirrorFlip, wallClimb.uuid),
            climbMirrored: wallClimb.mirrored,
          })
        : wallClimb.mirrored === true;

  const live = useMemo<WorkoutOutcomeTarget | null>(() => {
    if (!showLive || wallClimb === null || committedQueueItemUuid === null || sessionId === null) return null;
    if (renderBoard === null) return null;
    return {
      climb: wallClimb,
      queueItemUuid: committedQueueItemUuid,
      sessionId,
      boardName: renderBoard.boardName,
      layoutId: renderBoard.layoutId,
      sizeId: renderBoard.sizeId,
      setIds: renderBoard.setIds,
      angle: renderBoard.angle,
      isMirror,
    };
  }, [showLive, wallClimb, committedQueueItemUuid, sessionId, renderBoard, isMirror]);

  const shown = useWorkoutOutcomeHold({
    live,
    committedQueueItemUuid,
    // The bar always looks at the wall.
    displayedQueueItemUuid: committedQueueItemUuid,
    sessionId,
    canLog,
  });

  return { inTimedBlock, shown };
}
