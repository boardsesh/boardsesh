// The one place a mobile tick is saved.
//
// The Log ascent sheet (through useQuickTickForm) and, later, the workout
// player's one-tap buttons both log through here, so every tick gets the same
// board stamping, privacy choice, flash rule, analytics event, error copy and
// timer side effects. The caller owns its own fields and what happens after a
// save (toast, reset, closing the sheet).
//
// None of this runs from outbox replay: the drainer delivers a queued tick
// without this hook, so a tick that reaches the server twenty minutes late can
// never fire analytics twice or reset a live timer.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { hasGraphqlErrorCode } from '@boardsesh/offline-sync/error-classification';
import { resolveTickBoardContext, clampAttempts, type TickStatus } from '@boardsesh/play-view';
import {
  useOptionalBoardActions,
  useOptionalBoardLogbook,
  useSaveTick,
  logbookClimbAngleKey,
} from '@boardsesh/board-react';
import { toBoardName, type TickClimbIdentity } from '@boardsesh/board-config';
import { SHARED_EVENTS, boardTypeProperty } from '@boardsesh/analytics';
import { usePublicationAudience } from '../privacy/use-publication-audience';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';
import { useOptionalRogueTimer } from '../../providers/rogue-timer-provider';
import { getSetting } from '../../settings';
import { nowMs } from '../../lib/clock';
import { noteRestTimerTick } from '../../lib/rest-timer-store';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
import { useIsOffline } from '../../hooks/use-is-offline';
import { track } from '../../lib/analytics';
import { hapticError } from '../../lib/haptics';

/** Where the tick was logged from, as Tick Logged reports it. */
export type TickSurface = 'mobile_quick_tick' | 'mobile_workout_runner';

export type UseTickSaverInput = {
  climb?: TickClimbIdentity;
  climbUuid: string;
  boardName: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  /**
   * The board context is snapshotted when this turns true (and on a new climb),
   * so a presence or active-board change while the climber types can't move the
   * ascent to another wall. The sheet passes its visibility; a caller with no
   * open/close moment leaves it on.
   */
  active?: boolean;
  surface: TickSurface;
};

/** What one tick says. The saver adds the climb, board, session and privacy. */
export type TickSaveFields = {
  status: TickStatus;
  /** The tries the climber was shown. Clamped to the server's rules inside (a flash is one try). */
  attemptCount: number;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  /** Stars; 0 or null means no rating. */
  quality: number | null;
  difficulty: number | null;
  comment: string;
  /** The exact instant to log. The rest timer anchors on this same value. */
  climbedAtIso: string;
  /** The community send count for this angle, when the caller knows it. Local only. */
  baseAscensionistCount?: number;
  /** The picked difficulty's grade name, for analytics only. */
  gradeName?: string | null;
};

export type TickSaveHandlers = {
  /** After the side effects. The tick's uuid, when the save returned one. */
  onSaved?: (tickUuid: string | null) => void;
  /** The failure in the climber's language. */
  onFailed?: (message: string) => void;
};

export type TickSaver = {
  /** Starts a save. False when one is already in flight and nothing was sent. */
  save: (fields: TickSaveFields, handlers?: TickSaveHandlers) => boolean;
  isPending: boolean;
  privacy: ReturnType<typeof usePublicationAudience>;
  /** The board the tick is logged on: the climb's own, which may not be the active one. */
  tickBoardName: string;
};

/**
 * The shape the save resolves with. Optional because the save path's test
 * doubles resolve with nothing, and a missing uuid is only ever reported as null.
 */
type SavedTickResult = { savedTick: { uuid: string } } | undefined;

export function useTickSaver({
  climb,
  climbUuid,
  boardName,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  active = true,
  surface,
}: UseTickSaverInput): TickSaver {
  const { t: tClimbs } = useTranslation('climbs');
  const { t: tSettings } = useTranslation('settings');
  const privacy = usePublicationAudience(climbUuid);
  // Only the (stable, memoized) startStopwatch action is used here — depend on
  // it directly so save isn't recreated on every timer status / deviceName change.
  const startTimerStopwatch = useOptionalRogueTimer()?.startStopwatch;
  const { enabled: boardPresenceEnabled, boardId: boardPresenceBoardId } = useBoardPresenceControls();

  const { data: activeBoard } = useActiveBoard();
  const liveContext = resolveTickBoardContext(
    climb,
    { boardName, layoutId, sizeId, setIds },
    activeBoard ? { ...activeBoard, boardName: activeBoard.boardType } : null,
    boardPresenceEnabled ? boardPresenceBoardId : null,
  );
  // The selected wall is a snapshot of opening the form, not a live presence
  // binding that can move the ascent to another wall while someone types.
  const contextRef = useRef({ climbUuid, active, context: liveContext });
  if (contextRef.current.climbUuid !== climbUuid || (active && !contextRef.current.active)) {
    contextRef.current = { climbUuid, active, context: liveContext };
  }
  contextRef.current.active = active;
  const tickContext = contextRef.current.context;
  const saveTick = useSaveTick(toBoardName(tickContext.boardName));

  // Read through a ref so save's identity doesn't change on every connectivity
  // flip. A save that fails while offline has already exhausted the local write,
  // the retry ladder and the outbox degrade — the network error's own message is
  // a technical, English-only string, so say what happened in the climber's
  // language instead. Online, the error's own message is worth reading and stays.
  const isOffline = useIsOffline();
  const isOfflineRef = useRef(isOffline);
  isOfflineRef.current = isOffline;

  const save = useCallback(
    (fields: TickSaveFields, handlers?: TickSaveHandlers): boolean => {
      if (saveTick.isPending) return false;
      const { status, climbedAtIso } = fields;
      // Mirrors the server's flash-is-one-try rule; a no-op for every value the picker can show.
      const attemptCount = clampAttempts(fields.attemptCount, status);
      const quality = fields.quality !== null && fields.quality > 0 ? fields.quality : null;

      saveTick.mutate(
        {
          climbUuid,
          ...(privacy.publication ? { privacy: privacy.publication } : {}),
          angle: fields.angle,
          isMirror: fields.isMirror,
          status,
          attemptCount,
          quality,
          difficulty: fields.difficulty,
          isBenchmark: fields.isBenchmark,
          baseAscensionistCount: fields.baseAscensionistCount,
          comment: fields.comment,
          climbedAt: climbedAtIso,
          ...(sessionId ? { sessionId } : {}),
          ...(tickContext.layoutId != null ? { layoutId: tickContext.layoutId } : {}),
          ...('sizeId' in tickContext ? { sizeId: tickContext.sizeId, setIds: tickContext.setIds } : {}),
          ...('boardId' in tickContext ? { boardId: tickContext.boardId } : {}),
          ...('boardUuid' in tickContext ? { boardUuid: tickContext.boardUuid } : {}),
        },
        {
          onSuccess: (result: SavedTickResult) => {
            // One event per committed tick. This used to fire QuickTickSaved and
            // TickLogged back to back with the same climb/status, plus a
            // TickButtonClicked on the way in — four events per tick once
            // QuickTickOpened is counted. TickLogged is the canonical
            // cross-platform join event, so it absorbed QuickTickSaved's payload.
            track(SHARED_EVENTS.TickLogged, {
              climbUuid,
              layoutId: layoutId ?? null,
              // The board the tick was logged on, which is the tick's own board
              // and not necessarily the active one. `layoutId` cannot classify a
              // spray wall; this can.
              ...boardTypeProperty(boardName),
              status,
              platform: 'mobile',
              surface,
              attemptCount,
              hasQuality: quality !== null,
              hasDifficulty: fields.difficulty !== null,
              difficulty: fields.difficulty,
              grade: fields.gradeName ?? null,
              hasComment: fields.comment.length > 0,
            });
            // No haptic here: the caller's saved toast plays the success haptic.
            // Kick off the paired gym timer's stopwatch. No-op unless a Rogue
            // timer is connected — which only happens while this user is driving
            // the wall (see RogueTimerProvider), so a passenger's tick can't
            // touch the timer. Fire-and-forget; never block the save flow.
            void startTimerStopwatch?.();
            // Anchor the in-app rest timer on the same instant (#5378). No-op
            // unless the climber armed it. This runs on the offline-queued
            // delivery too, which is correct: a rest timer is about when YOU
            // logged the send, not when the server heard about it. The outbox
            // drainer replays without this hook, so a tick delivered twenty
            // minutes later can never reset a live timer.
            noteRestTimerTick(climbedAtIso, getSetting('restTimerMode'), nowMs());
            handlers?.onSaved?.(result?.savedTick.uuid ?? null);
          },
          onError: (error: unknown) => {
            hapticError();
            track(SHARED_EVENTS.QuickTickFailed, { climbUuid, layoutId: layoutId ?? null });
            const message = hasGraphqlErrorCode(error, 'PRIVACY_REVISION_CONFLICT')
              ? tSettings('privacy.revisionChanged')
              : isOfflineRef.current
                ? tClimbs('mobile.logAscent.offlineErrorMessage')
                : isClimbNotFound(error)
                  ? // The setter deleted it (#5960), or it never existed. The server's
                    // own words are English-only, so say it in the climber's language.
                    tClimbs('mobile.logAscent.climbDeletedMessage')
                  : error instanceof Error && error.message
                    ? error.message
                    : tClimbs('mobile.logAscent.errorMessage');
            handlers?.onFailed?.(message);
          },
        },
      );
      return true;
    },
    [
      saveTick,
      privacy.publication,
      climbUuid,
      boardName,
      layoutId,
      sessionId,
      tickContext,
      surface,
      startTimerStopwatch,
      tClimbs,
      tSettings,
    ],
  );

  return {
    save,
    isPending: saveTick.isPending,
    privacy,
    tickBoardName: tickContext.boardName,
  };
}

/**
 * Whether the climber has logged this climb at this angle before, which decides
 * Flash vs Send. When the answer isn't known yet it says yes, so the button
 * reads Send: a wrong Send costs a label, a wrong Flash writes a phantom flash.
 *
 * Mobile's `Climb.userAscents`/`userAttempts` GraphQL fields aren't populated
 * server-side, so this reads the user's accumulated logbook (denormalised via
 * `BoardProvider` → `useLogbook`) directly — the same source the climb-row
 * status glyph reads. Two failure modes it guards against:
 * 1. `BoardProvider` not mounted → no logbook context at all → history assumed.
 * 2. Provider is mounted but this climb's ticks haven't been fetched yet → the
 *    lookup returns nothing. `getLogbook` is triggered on mount (idempotent
 *    thanks to useLogbook's fetched-uuid dedupe) so the answer becomes
 *    authoritative on the next render after the fetch resolves.
 *
 * It reads the prebuilt `logbookByClimbAngle` index (an O(1) Map lookup the
 * BoardProvider rebuilds once per logbook change) rather than scanning the raw
 * `logbook` array — otherwise every logbook merge while the caller is mounted
 * (own tick saves, list paging, peer ticks in a session) re-runs an O(logbook)
 * scan. Same index `useAscentStatus` reads.
 *
 * `boardName` is the tick's board (`TickSaver.tickBoardName`), which keys the
 * locally queued ticks.
 */
export function useHasPriorTickHistory(climbUuid: string, boardName: string, angle: number): boolean {
  const boardActions = useOptionalBoardActions();
  const boardLogbook = useOptionalBoardLogbook();
  const { data: localPendingTicks = 0 } = useLocalPendingTicks(climbUuid, boardName);
  useEffect(() => {
    if (!boardActions) return;
    void boardActions.getLogbook([climbUuid]);
  }, [boardActions, climbUuid]);

  return useMemo(() => {
    // A locally-queued tick that hasn't drained yet still counts as history so
    // the label stays `Send` while offline.
    // The pending count is per climb, not per angle, so an offline-queued 40°
    // tick also reads Send at 45°. Conservative on purpose: a wrong Send costs a
    // label, a wrong Flash writes a phantom flash.
    if (localPendingTicks > 0) return true;
    // No provider → assume history so the label stays `Send` (failure mode 1).
    if (!boardLogbook) return true;
    // Not fetched yet → also assume history (failure mode 2). An empty index
    // lookup can't distinguish "no ticks" from "not loaded", and guessing
    // "no ticks" offers a green Flash on a climb the user has sent many times;
    // tapping it in that window writes a phantom flash, which is worse than a
    // Send label that resolves to Flash a moment later (#3940).
    if (!boardLogbook.fetchedLogbookClimbUuids.has(climbUuid)) return true;
    // Flash vs Send asks about the angle being logged, not the one the caller
    // opened at: a climb sent at 40° is a flash candidate at 45°.
    return (boardLogbook.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle))?.length ?? 0) > 0;
  }, [boardLogbook, climbUuid, angle, localPendingTicks]);
}

/**
 * The first ascent of a spray climb (#5971): nobody has sent it, so the
 * climber's grade becomes the climb's grade. Spray only, where the climbers'
 * vote is the grade. `baseAscensionistCount` belongs to one angle, so a caller
 * logging at another angle must not treat this as a first ascent.
 */
export function isFirstAscentTick(boardName: string | undefined, baseAscensionistCount: number): boolean {
  return boardName === 'spray' && baseAscensionistCount === 0;
}

/** A save the server refused because the climb is gone (`saveTick`'s CLIMB_NOT_FOUND). */
function isClimbNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const lifted = (error as { extensions?: { code?: unknown } | null }).extensions?.code;
  return (typeof lifted === 'string' ? lifted : extractGraphqlCode(error)) === 'CLIMB_NOT_FOUND';
}
