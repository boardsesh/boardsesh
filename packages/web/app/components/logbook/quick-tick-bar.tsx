'use client';

import React, { useState, useCallback, useEffect, useMemo, useImperativeHandle, useRef, forwardRef } from 'react';
import Stack from '@mui/material/Stack';
import { track } from '@vercel/analytics';
import { Angle, Climb, BoardDetails } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import type { LogbookEntry, TickStatus } from '@/app/hooks/use-logbook';
import { TENSION_KILTER_GRADES } from '@/app/lib/board-data';
import { useChalkPuff } from '@/app/hooks/use-chalk-puff';
import { saveTickDraft, loadTickDraft, clearTickDraft } from '@/app/lib/tick-draft-db';
import {
  TickControls,
  TickGradeButton,
  InlineStarPicker,
  InlineGradePicker,
  InlineTriesPicker,
  type ExpandedControl,
} from './tick-controls';
import styles from './quick-tick-bar.module.css';

/** Snapshot of the tick target taken when the bar is first opened with a valid climb. */
interface TickTarget {
  climb: Climb;
  angle: Angle;
  boardDetails: BoardDetails;
  /** Whether the user has any prior logbook history for this climb at open time. */
  hasPriorHistory: boolean;
}

export interface QuickTickBarProps {
  currentClimb: Climb | null;
  angle: Angle;
  boardDetails: BoardDetails;
  onSave: () => void;
  /** Called when a save fails so the parent can show feedback. */
  onError?: () => void;
  /** Called when a draft is restored from a previous failed save. */
  onDraftRestored?: (comment: string) => void;
  /** Current comment text. Owned by the parent so the comment field can live
   *  outside this bar (above the queue control bar) without causing reflow. */
  comment: string;
  /** Comment input element rendered by the parent — placed in the row next to tick controls. */
  commentSlot: React.ReactNode;
}

export interface QuickTickBarHandle {
  /** Trigger a save (ascent). Called by the parent tick button. */
  save: () => void;
  /** Trigger a save (attempt). Pass the origin element for chalk puff positioning. */
  saveAttempt: (originElement?: HTMLElement | null) => void;
}

/**
 * Stateful tick entry wrapper. Manages the tick target snapshot, form state
 * (quality, difficulty, attempts), expansion state, and save logic.
 *
 * Layout mirrors the queue control bar below:
 *   [comment (flex:1) + grade] [stars + tries]
 * so the user grade aligns vertically with the consensus grade.
 */
export const QuickTickBar = forwardRef<QuickTickBarHandle, QuickTickBarProps>(({
  currentClimb,
  angle,
  boardDetails,
  onSave,
  onError,
  onDraftRestored,
  comment,
  commentSlot,
}, ref) => {
  const { saveTick, logbook } = useBoardProvider();
  const fireChalkPuff = useChalkPuff();

  // Snapshot the target climb the first time we get a non-null climb.
  // Uses a ref flag so it only fires once, avoiding re-snapshot when
  // angle/boardDetails/logbook change after the initial capture.
  // NOTE: tickTargetTaken resets only on unmount — this works because
  // QuickTickBar is unmounted when tick mode closes (see queue-control-bar).
  const tickTargetTaken = useRef(false);
  const [tickTarget, setTickTarget] = useState<TickTarget | null>(() => {
    if (currentClimb) {
      tickTargetTaken.current = true;
      return buildTickTarget(currentClimb, angle, boardDetails, logbook);
    }
    return null;
  });
  useEffect(() => {
    if (!tickTargetTaken.current && currentClimb) {
      tickTargetTaken.current = true;
      setTickTarget(buildTickTarget(currentClimb, angle, boardDetails, logbook));
    }
  }, [currentClimb, angle, boardDetails, logbook]);

  const [quality, setQuality] = useState<number | null>(null);
  const [difficulty, setDifficulty] = useState<number | undefined>(undefined);
  const [attemptCount, setAttemptCount] = useState<number>(1);
  const [expandedControl, setExpandedControl] = useState<ExpandedControl>(null);

  // Restore draft values from a previous failed save for this climb.
  const draftLoaded = useRef(false);
  useEffect(() => {
    if (!tickTarget || draftLoaded.current) return;
    draftLoaded.current = true;
    loadTickDraft(tickTarget.climb.uuid, Number(tickTarget.angle)).then((draft) => {
      if (!draft) return;
      setQuality(draft.quality);
      setDifficulty(draft.difficulty);
      setAttemptCount(draft.attemptCount);
      if (draft.comment) {
        onDraftRestored?.(draft.comment);
      }
    });
  }, [tickTarget, onDraftRestored]);
  // Track which picker was last open so we can keep it mounted during collapse.
  const [lastExpandedControl, setLastExpandedControl] = useState<ExpandedControl>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  useEffect(() => {
    if (expandedControl) {
      setLastExpandedControl(expandedControl);
      setPickerVisible(true);
    } else {
      // Keep content mounted during the 200ms CSS grid collapse transition.
      const timer = setTimeout(() => setPickerVisible(false), 200);
      return () => clearTimeout(timer);
    }
  }, [expandedControl]);

  // The control to actually render — either the currently expanded one, or
  // the last one that was open (kept alive during the collapse animation).
  const renderedControl = expandedControl ?? (pickerVisible ? lastExpandedControl : null);

  const gradeButtonRef = useRef<HTMLButtonElement>(null);
  const triesButtonRef = useRef<HTMLButtonElement>(null);

  const grades = TENSION_KILTER_GRADES;

  const currentGradeId = difficulty;

  const consensusGradeId = useMemo(() => {
    const source = tickTarget?.climb.difficulty;
    if (!source) return undefined;
    return grades.find((g) => g.difficulty_name === source)?.difficulty_id;
  }, [tickTarget, grades]);

  // Picker selection handlers — select the value and collapse the picker.
  const handleStarSelect = useCallback((value: number | null) => {
    setQuality(value);
    setExpandedControl(null);
  }, []);

  const handleGradeSelect = useCallback((value: number | undefined) => {
    setDifficulty(value);
    setExpandedControl(null);
  }, []);

  const handleTriesSelect = useCallback((value: number) => {
    setAttemptCount(value);
    setExpandedControl(null);
  }, []);

  const handleSave = useCallback(
    (isAscent: boolean, chalkOrigin?: HTMLElement | null) => {
      if (!tickTarget) return;

      const { climb, angle: targetAngle, boardDetails: targetBoard, hasPriorHistory } = tickTarget;

      let status: TickStatus;
      if (isAscent) {
        status = hasPriorHistory || attemptCount > 1 ? 'send' : 'flash';
      } else {
        status = 'attempt';
      }

      // Capture values for the draft in case the save fails.
      const draftValues = { climbUuid: climb.uuid, angle: Number(targetAngle), quality, difficulty, attemptCount, comment, status };

      // Fire chalk puff and close the bar immediately — don't wait for the network.
      fireChalkPuff(chalkOrigin ?? document.getElementById('button-tick'));
      onSave();

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
        setIds: Array.isArray(targetBoard.set_ids)
          ? targetBoard.set_ids.join(',')
          : String(targetBoard.set_ids),
      }).then(() => {
        track('Quick Tick Saved', {
          boardLayout: targetBoard.layout_name || '',
          status,
          attemptCount,
          hasQuality: quality !== null,
          hasDifficulty: difficulty !== undefined,
          hasComment: comment.length > 0,
        });
        clearTickDraft(climb.uuid, Number(targetAngle));
      }).catch(() => {
        track('Quick Tick Failed', {
          boardLayout: targetBoard.layout_name || '',
        });
        saveTickDraft(draftValues);
        onError?.();
      });
    },
    [tickTarget, quality, difficulty, comment, saveTick, onSave, attemptCount, fireChalkPuff, onError],
  );

  const handleConfirm = useCallback(() => handleSave(true), [handleSave]);
  const handleAttempt = useCallback((originElement?: HTMLElement | null) => handleSave(false, originElement), [handleSave]);

  useImperativeHandle(ref, () => ({
    save: handleConfirm,
    saveAttempt: handleAttempt,
  }), [handleConfirm, handleAttempt]);

  return (
    <div data-testid="quick-tick-bar" className={styles.tickBar}>
      {/* Picker panel — expands above the controls row when a control is active */}
      <div className={`${styles.pickerPanel} ${expandedControl ? styles.pickerPanelExpanded : ''}`}>
        <div className={styles.pickerPanelContent}>
          {renderedControl === 'stars' && (
            <InlineStarPicker quality={quality} onSelect={handleStarSelect} />
          )}
          {renderedControl === 'grade' && (
            <InlineGradePicker
              grades={grades}
              currentGradeId={currentGradeId}
              focusGradeId={consensusGradeId}
              onSelect={handleGradeSelect}
              gradeButtonRef={gradeButtonRef}
            />
          )}
          {renderedControl === 'tries' && (
            <InlineTriesPicker attemptCount={attemptCount} onSelect={handleTriesSelect} triesButtonRef={triesButtonRef} />
          )}
        </div>
      </div>

      {/* Controls row — mirrors the queue bar layout:
          [comment + grade (flex:1)] [stars + tries (flex:none)]
          so user grade aligns with the consensus grade below. */}
      <div className={styles.controlsRow}>
        {/* Left section: comment fills space, grade sits at right edge —
            mirrors the queue bar's [thumbnail + title + grade] column. */}
        <div className={styles.leftSection}>
          {/* Collapse any open picker when the comment field gains focus */}
          <div role="group" onFocus={() => setExpandedControl(null)} className={styles.commentWrapper}>
            {commentSlot}
          </div>
          <TickGradeButton
            ref={gradeButtonRef}
            difficulty={difficulty}
            displayedGrades={grades}
            expandedControl={expandedControl}
            onExpandedControlChange={setExpandedControl}
          />
        </div>

        {/* Right section: stars + tries — mirrors the queue bar's button
            cluster (Close + Tick) so widths match and grades align. */}
        <div className={styles.rightControls}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <TickControls
              quality={quality}
              attemptCount={attemptCount}
              expandedControl={expandedControl}
              onExpandedControlChange={setExpandedControl}
              triesButtonRef={triesButtonRef}
            />
          </Stack>
        </div>
      </div>
    </div>
  );
});

QuickTickBar.displayName = 'QuickTickBar';

/**
 * Decide whether the user has any prior history for a climb at open time.
 */
export function hasPriorHistoryForClimb(
  climb: Climb,
  logbook: LogbookEntry[],
): boolean {
  const ascents = climb.userAscents;
  const attempts = climb.userAttempts;
  if (ascents != null || attempts != null) {
    return (ascents ?? 0) + (attempts ?? 0) > 0;
  }
  return logbook.some((entry) => entry.climb_uuid === climb.uuid);
}

function buildTickTarget(
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
