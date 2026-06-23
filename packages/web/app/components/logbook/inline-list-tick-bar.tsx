'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import type { Climb, BoardDetails, Angle } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { getGradesForBoard } from '@/app/lib/board-data';
import { loadTickDraft } from '@/app/lib/tick-draft-db';
import { useTickSave, buildTickTarget, type TickTarget } from '@/app/hooks/use-tick-save';
import {
  TickControls,
  TickGradeButton,
  InlineStarPicker,
  InlineGradePicker,
  InlineTriesPicker,
  type ExpandedControl,
} from './tick-controls';
import styles from './inline-list-tick-bar.module.css';

export type InlineListTickBarProps = {
  climb: Climb;
  angle: Angle;
  boardDetails: BoardDetails;
  onClose: () => void;
  /** Called when a save fails so the parent can show feedback. */
  onError?: () => void;
};

export const InlineListTickBar: React.FC<InlineListTickBarProps> = ({
  climb,
  angle,
  boardDetails,
  onClose,
  onError,
}) => {
  const { t } = useTranslation('climbs');
  const { logbook } = useBoardProvider();

  // Snapshot the tick target once on mount. climb is a required prop so the
  // initializer always produces a value. This avoids recomputing
  // hasPriorHistory on every logbook mutation (logbook is a new array
  // reference after each optimistic save).
  const [tickTarget] = useState<TickTarget | null>(() => buildTickTarget(climb, angle, boardDetails, logbook));

  const [quality, setQuality] = useState<number | null>(null);
  const [difficulty, setDifficulty] = useState<number | undefined>(undefined);
  const [attemptCount, setAttemptCount] = useState<number>(1);
  const [expandedControl, setExpandedControl] = useState<ExpandedControl>(null);

  // Restore draft values from a previous failed save
  const draftLoaded = useRef(false);
  useEffect(() => {
    if (!tickTarget || draftLoaded.current) return;
    draftLoaded.current = true;
    let cancelled = false;
    void loadTickDraft(tickTarget.climb.uuid, Number(tickTarget.angle)).then((draft) => {
      if (cancelled || !draft) return;
      setQuality(draft.quality);
      setDifficulty(draft.difficulty);
      setAttemptCount(draft.attemptCount);
    });
    return () => {
      cancelled = true;
    };
  }, [tickTarget]);

  // Track picker visibility for collapse animation
  const [lastExpandedControl, setLastExpandedControl] = useState<ExpandedControl>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  useEffect(() => {
    if (expandedControl) {
      setLastExpandedControl(expandedControl);
      setPickerVisible(true);
    } else {
      const timer = setTimeout(() => setPickerVisible(false), 200);
      return () => clearTimeout(timer);
    }
  }, [expandedControl]);

  const renderedControl = expandedControl ?? (pickerVisible ? lastExpandedControl : null);

  const gradeButtonRef = useRef<HTMLButtonElement>(null);
  const triesButtonRef = useRef<HTMLButtonElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const attemptButtonRef = useRef<HTMLButtonElement>(null);

  const grades = useMemo(() => getGradesForBoard(boardDetails.board_name), [boardDetails.board_name]);

  const currentGradeId = difficulty;

  const consensusGradeId = useMemo(() => {
    const source = tickTarget?.climb.difficulty;
    if (!source) return undefined;
    return grades.find((g) => g.difficulty_name === source)?.difficulty_id;
  }, [tickTarget, grades]);

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

  const { save, saveAttempt } = useTickSave({
    tickTarget,
    quality,
    difficulty,
    attemptCount,
    comment: '',
    onSave: onClose,
    onError,
  });

  const handleSaveClick = useCallback(() => {
    save(saveButtonRef.current);
  }, [save]);

  const handleAttemptClick = useCallback(() => {
    saveAttempt(attemptButtonRef.current);
  }, [saveAttempt]);

  return (
    <div className={styles.tickBarWrapper}>
      <div className={styles.tickBarInner}>
        {/* Picker panel — expands above the controls row */}
        <div className={`${styles.pickerPanel} ${expandedControl ? styles.pickerPanelExpanded : ''}`}>
          <div className={styles.pickerPanelContent}>
            {renderedControl === 'stars' && <InlineStarPicker quality={quality} onSelect={handleStarSelect} />}
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
              <InlineTriesPicker
                attemptCount={attemptCount}
                onSelect={handleTriesSelect}
                triesButtonRef={triesButtonRef}
              />
            )}
          </div>
        </div>

        {/* Controls row */}
        <div className={styles.controlsRow}>
          <div className={styles.leftSection}>
            <TickGradeButton
              ref={gradeButtonRef}
              difficulty={difficulty}
              displayedGrades={grades}
              expandedControl={expandedControl}
              onExpandedControlChange={setExpandedControl}
            />
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
          <div className={styles.rightButtons}>
            <IconButton
              ref={saveButtonRef}
              size="small"
              onClick={handleSaveClick}
              aria-label={t('tick.bar.logAscent')}
              sx={{
                width: 36,
                height: 36,
                backgroundColor: 'var(--color-success)',
                color: 'common.white',
                '&:hover': { backgroundColor: 'var(--color-success)' },
              }}
            >
              <CheckOutlined sx={{ fontSize: 18 }} />
            </IconButton>
            <IconButton
              ref={attemptButtonRef}
              size="small"
              onClick={handleAttemptClick}
              aria-label={t('tick.bar.logAttempt')}
              sx={{
                width: 36,
                height: 36,
                backgroundColor: 'var(--color-error)',
                color: 'common.white',
                '&:hover': { backgroundColor: 'var(--color-error)' },
              }}
            >
              <PersonFallingIcon sx={{ fontSize: 18 }} />
            </IconButton>
            <IconButton
              size="small"
              onClick={onClose}
              aria-label={t('tick.bar.cancel')}
              sx={{
                width: 28,
                height: 28,
                color: 'text.disabled',
              }}
            >
              <CloseOutlined sx={{ fontSize: 16 }} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
};
