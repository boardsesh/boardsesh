import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  BUSY_WALL_TAP_DEBOUNCE_MS,
  resolveBusyWallQuestion,
  type BusyWallQuestionModel,
  type BusyWallSegmentId,
} from './busy-wall-question';
import { formatBusyWallCaption } from './busy-wall-question-text';
import type { WallControlFace } from './wall-control';

export type UseBusyWallQuestionOptions = {
  /** The question is up: someone else moved the wall while this climber looked around. */
  armed: boolean;
  /** Who put the lit climb up (`resolveBusyWallHolder`). */
  holder: WallControlFace | null;
  wallClimbName: string | null;
  /** This phone holds the board. */
  selfHoldsBoard: boolean;
  /** Leave their climb up and go back to it. Nothing is sent. */
  onKeep: () => void;
  /** Put the climb on screen up over theirs. */
  onPut: () => void;
  /** Which segment leads; the dev switch's default when left out. */
  primary?: BusyWallSegmentId;
};

export type BusyWallQuestion = {
  /** Null while no question is up. */
  model: BusyWallQuestionModel | null;
  /** Keep theirs. Dropped for the first 500 ms of a question; the plain way back otherwise. */
  keep: () => void;
  /** Put mine up. Dropped for the first 500 ms of a question; the plain commit otherwise. */
  put: () => void;
};

/**
 * The one handler behind the busy-wall question (#7017), in both Board control
 * modes. It builds the model, drops taps on either segment for
 * `BUSY_WALL_TAP_DEBOUNCE_MS` after the question appears (the wall-change
 * debounce: a thumb already on its way to the wall button would otherwise
 * answer a question it never read), and has VoiceOver say the caption once
 * when the question appears.
 *
 * The handlers keep their identity across renders, so a memoised bar doesn't
 * re-render for them.
 */
export function useBusyWallQuestion({
  armed,
  holder,
  wallClimbName,
  selfHoldsBoard,
  onKeep,
  onPut,
  primary,
}: UseBusyWallQuestionOptions): BusyWallQuestion {
  const { t } = useTranslation('session');
  const [ready, setReady] = useState(false);
  // When the question appeared; null while none is up. Taps read it directly,
  // so one that lands before the re-render to `ready` is still dropped.
  const armedAtRef = useRef<number | null>(null);

  const model = useMemo(
    () => (armed ? resolveBusyWallQuestion({ holder, wallClimbName, selfHoldsBoard, ready, primary }) : null),
    [armed, holder, wallClimbName, selfHoldsBoard, ready, primary],
  );
  const latest = useRef({ model, onKeep, onPut });
  latest.current = { model, onKeep, onPut };

  useEffect(() => {
    if (!armed) {
      armedAtRef.current = null;
      setReady(false);
      return undefined;
    }
    armedAtRef.current = Date.now();
    setReady(false);
    // Said once, when it appears: the caption is the question; the segments are the answers.
    const current = latest.current.model;
    if (current) AccessibilityInfo.announceForAccessibility(formatBusyWallCaption(current, t));
    const timer = setTimeout(() => setReady(true), BUSY_WALL_TAP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Keyed on `armed` alone: a name that resolves later must not restart the
    // debounce or speak the caption again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed]);

  // With no question up a tap is the plain commit (or the plain way back), so
  // it passes straight through; only a question that just appeared holds taps.
  const accepts = useCallback(() => {
    const armedAt = armedAtRef.current;
    return armedAt === null || Date.now() - armedAt >= BUSY_WALL_TAP_DEBOUNCE_MS;
  }, []);
  const keep = useCallback(() => {
    if (accepts()) latest.current.onKeep();
  }, [accepts]);
  const put = useCallback(() => {
    if (accepts()) latest.current.onPut();
  }, [accepts]);

  return { model, keep, put };
}
