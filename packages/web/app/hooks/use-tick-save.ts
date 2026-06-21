'use client';

import { useCallback, useEffect, useRef } from 'react';
import { track } from '@/app/lib/analytics';
import { hasPriorHistoryForClimb as _hasPriorHistoryForClimb } from '@boardsesh/play-view';
import type { Climb, BoardDetails, Angle } from '@/app/lib/types';
import { useBoardProvider } from '../components/board-provider/board-provider-context';
import type { LogbookEntry, TickStatus } from '@boardsesh/board-react';
import { useConfetti } from './use-confetti';
import { saveTickDraft, clearTickDraft } from '@/app/lib/tick-draft-db';
import { useBoardPresenceControls } from '../components/board-presence/board-presence-context';

/** Snapshot of the tick target taken when the bar is first opened with a valid climb. */
export type TickTarget = {
  climb: Climb;
  angle: Angle;
  boardDetails: BoardDetails;
  /** Whether the user has any prior logbook history for this climb at open time. */
  hasPriorHistory: boolean;
};

export type UseTickSaveOptions = {
  tickTarget: TickTarget | null;
  quality: number | null;
  difficulty: number | undefined;
  attemptCount: number;
  comment: string;
  /** Explicit ascent type. When provided, overrides the inferred status logic. */
  ascentType?: TickStatus;
  onSave: () => void;
  onError?: () => void;
};

/**
 * Decide whether the user has any prior history for a climb at open time.
 * Re-exported from @boardsesh/play-view for backward compatibility.
 */
export const hasPriorHistoryForClimb: (climb: Climb, logbook: LogbookEntry[]) => boolean = _hasPriorHistoryForClimb;

export function buildTickTarget(
  climb: Climb,
  angle: Angle,
  boardDetails: BoardDetails,
  logbook: LogbookEntry[],
): TickTarget {
  return {
    climb,
    angle,
    boardDetails,
    hasPriorHistory: hasPriorHistoryForClimb(climb, logbook),
  };
}

/**
 * Reusable hook that encapsulates the tick save logic (ascent and attempt).
 *
 * Internally calls `useBoardProvider().saveTick` and `useConfetti()`.
 * Fires confetti, closes the bar immediately via `onSave`, then performs
 * an optimistic fire-and-forget save. On failure, persists a draft to
 * IndexedDB and calls `onError`.
 */
export function useTickSave(options: UseTickSaveOptions): {
  save: (originElement?: HTMLElement | null) => void;
  saveAttempt: (originElement?: HTMLElement | null) => void;
} {
  const {
    tickTarget,
    quality,
    difficulty,
    attemptCount,
    comment,
    ascentType: explicitAscentType,
    onSave,
    onError,
  } = options;
  const { saveTick } = useBoardProvider();
  const { boardId: presenceBoardId } = useBoardPresenceControls();
  const fireConfetti = useConfetti();
  const saving = useRef(false);
  const flashDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the flash delay timeout on unmount to prevent state updates on unmounted components.
  useEffect(() => {
    return () => {
      if (flashDelayTimer.current) clearTimeout(flashDelayTimer.current);
    };
  }, []);

  const handleSave = useCallback(
    (isAscent: boolean, confettiOrigin?: HTMLElement | null, forceAttempt?: boolean) => {
      if (!tickTarget || saving.current) return;
      saving.current = true;

      const { climb, angle: targetAngle, boardDetails: targetBoard, hasPriorHistory } = tickTarget;

      let status: TickStatus;
      if (forceAttempt) {
        status = 'attempt';
      } else if (explicitAscentType) {
        status = explicitAscentType;
      } else if (isAscent) {
        status = hasPriorHistory || attemptCount > 1 ? 'send' : 'flash';
      } else {
        status = 'attempt';
      }

      // Capture values for the draft in case the save fails.
      const draftValues = {
        climbUuid: climb.uuid,
        angle: Number(targetAngle),
        quality,
        difficulty,
        attemptCount,
        comment,
        status,
      };

      // Fire celebration and close the bar -- don't wait for the network.
      // When an explicit ascentType is provided, derive the variant from status
      // (the isAscent boolean is only meaningful for the legacy two-method API).
      const resolveVariant = () => {
        if (explicitAscentType) {
          if (status === 'attempt') return 'attempt';
          if (status === 'flash') return 'flash';
          return 'ascent';
        }
        if (!isAscent) return 'attempt';
        if (status === 'flash') return 'flash';
        return 'ascent';
      };
      const variant = resolveVariant();
      fireConfetti(confettiOrigin ?? null, variant);
      // Flash: brief 300ms delay so the button pulse + sparks play before the bar closes.
      if (variant === 'flash') {
        flashDelayTimer.current = setTimeout(() => {
          flashDelayTimer.current = null;
          onSave();
        }, 300);
      } else {
        onSave();
      }

      // Fire-and-forget: the logbook cache updates optimistically via useSaveTick's onMutate.
      saveTick({
        climbUuid: climb.uuid,
        angle: Number(targetAngle),
        isMirror: !!climb.mirrored,
        status,
        attemptCount,
        quality: quality ?? undefined,
        difficulty,
        isBenchmark: false,
        comment: comment || '',
        climbedAt: new Date().toISOString(),
        layoutId: targetBoard.layout_id,
        sizeId: targetBoard.size_id,
        setIds: Array.isArray(targetBoard.set_ids) ? targetBoard.set_ids.join(',') : String(targetBoard.set_ids),
        ...(presenceBoardId !== null ? { boardId: presenceBoardId } : {}),
      })
        .then(() => {
          track('Quick Tick Saved', {
            boardLayout: targetBoard.layout_name || '',
            status,
            attemptCount,
            hasQuality: quality !== null,
            hasDifficulty: difficulty !== undefined,
            hasComment: comment.length > 0,
          });
          void clearTickDraft(climb.uuid, Number(targetAngle));
          saving.current = false;
        })
        .catch(() => {
          track('Quick Tick Failed', {
            boardLayout: targetBoard.layout_name || '',
          });
          void saveTickDraft(draftValues);
          saving.current = false;
          onError?.();
        });
    },
    [
      tickTarget,
      quality,
      difficulty,
      comment,
      explicitAscentType,
      saveTick,
      onSave,
      attemptCount,
      fireConfetti,
      onError,
      presenceBoardId,
    ],
  );

  const save = useCallback(
    (originElement?: HTMLElement | null) => handleSave(true, originElement, false),
    [handleSave],
  );
  const saveAttempt = useCallback(
    (originElement?: HTMLElement | null) => handleSave(false, originElement, true),
    [handleSave],
  );

  return { save, saveAttempt };
}
