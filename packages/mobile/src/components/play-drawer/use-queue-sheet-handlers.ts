import { useCallback } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type {
  Climb as QueueClimb,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import type {
  BoardConfig,
  LogAscentInput,
  OpenClimbActionsOptions,
  OpenPlayDrawerOptions,
} from '../../providers/drawer-host-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';

type QueueSheetHandlerDeps = {
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  openPlayDrawer: (climb: Climb, options?: OpenPlayDrawerOptions) => void;
  openClimbActions: (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => void;
  openLogAscent: (input: LogAscentInput) => void;
  /** The user's STORED active board (never a drawer override) — the queue renders
   *  against it, and a tick-history log is filed against it. */
  storedBoardConfig: BoardConfig | null;
  sessionId: string | null;
  /** Dismiss the QueueSheet this set of handlers drives (the host's instance or
   *  the play-route's instance). */
  requestCloseQueueSheet: () => void;
  /** Await the exact QueueSheet instance this handler set drives. */
  dismissQueueSheetAndWait: () => Promise<DismissAndWaitResult>;
};

type QueueSheetHandlers = {
  handleClimbPress: (item: ClimbQueueItem) => void;
  handleOpenActions: (item: ClimbQueueItem) => void;
  handleSuggestionPress: (climb: QueueClimb, source: PlaylistSuggestionSource) => void;
  handleTickHistory: (item: ClimbQueueItem) => void;
};

/**
 * The four QueueSheet row handlers, shared by the two QueueSheet instances: the
 * host's (snackbar / closed-player) and the play-route's (open-player, so the
 * sheet stacks above the player VC). Extracted so the two can't drift — both
 * present the same climb in the play drawer, open the same reaction menu, and
 * file the same tick. The only difference is `requestCloseQueueSheet`, which
 * dismisses whichever instance the caller owns.
 */
export function useQueueSheetHandlers({
  setCurrentClimb,
  openPlayDrawer,
  openClimbActions,
  openLogAscent,
  storedBoardConfig,
  sessionId,
  requestCloseQueueSheet,
  dismissQueueSheetAndWait,
}: QueueSheetHandlerDeps): QueueSheetHandlers {
  // Tap a queue item → make it current (for the whole session, always-live) and
  // show it in the play drawer.
  const handleClimbPress = useCallback(
    (item: ClimbQueueItem) => {
      setCurrentClimb(item);
      openPlayDrawer(item.climb, { committedExternally: true });
      requestCloseQueueSheet();
    },
    [setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Long-press a queue row → open the climb reaction menu over the queue sheet.
  // The queue renders against the active board, so the default boardConfig is
  // correct.
  const handleOpenActions = useCallback(
    (item: ClimbQueueItem) => {
      // `queueItemUuid` names the exact row that was long-pressed, so "Play next"
      // moves that slot instead of the first copy of a twice-queued climb.
      openClimbActions(item.climb, undefined, {
        dismissSourceSheet: dismissQueueSheetAndWait,
        queueItemUuid: item.uuid,
      });
    },
    [openClimbActions, dismissQueueSheetAndWait],
  );

  // Tap a suggestion → activate it with a suggestion source built from the
  // suggestions list (so the play drawer can keep swiping forward through them)
  // and show it.
  const handleSuggestionPress = useCallback(
    (climb: QueueClimb, source: PlaylistSuggestionSource) => {
      const item = climbToQueueItem(climb, { suggested: true });
      const schemaClimb = item.climb as Climb;
      setCurrentClimb(item, { playlistSuggestionSource: source });
      openPlayDrawer(schemaClimb, { committedExternally: true });
      requestCloseQueueSheet();
    },
    [setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Tick a history climb → open the log-ascent sheet (stacks above the queue
  // sheet, which stays open beneath) pre-filled with the active session.
  const handleTickHistory = useCallback(
    (item: ClimbQueueItem) => {
      if (!storedBoardConfig) return;
      openLogAscent({
        climbUuid: item.climb.uuid,
        climbName: item.climb.name,
        boardName: storedBoardConfig.boardName,
        angle: storedBoardConfig.angle,
        isMirror: item.climb.mirrored === true,
        isBenchmark: !!item.climb.benchmark_difficulty,
        baseAscensionistCount: item.climb.ascensionist_count ?? 0,
        layoutId: storedBoardConfig.layoutId,
        sizeId: storedBoardConfig.sizeId,
        setIds: storedBoardConfig.setIds,
        sessionId,
        consensusGradeName: item.climb.difficulty,
      });
    },
    [storedBoardConfig, sessionId, openLogAscent],
  );

  return { handleClimbPress, handleOpenActions, handleSuggestionPress, handleTickHistory };
}
