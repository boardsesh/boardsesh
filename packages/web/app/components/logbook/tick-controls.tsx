'use client';

import React, { useRef, useState, useLayoutEffect, useEffect, useCallback, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import ButtonBase from '@mui/material/ButtonBase';
import Skeleton from '@mui/material/Skeleton';
import StarIcon from '@mui/icons-material/Star';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { themeTokens } from '@/app/theme/theme-config';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import styles from './tick-controls.module.css';

export type ExpandedControl = 'grade' | 'stars' | 'tries' | 'angle' | null;

/**
 * Stops horizontal touch events from propagating to parent swipeable handlers,
 * while allowing vertical touches through so swipe-to-dismiss still works.
 *
 * Touch handling uses two layers:
 * - CSS `touch-action: pan-x` on `.tickRow` prevents the browser from
 *   scrolling the underlying page during vertical swipes (handled by JS).
 * - This JS hook stops horizontal touch propagation so the parent
 *   `useSwipeable` doesn't interfere with native picker scroll.
 * Both are needed because `useSwipeable` intercepts events before the
 * browser can apply `touch-action` constraints.
 */
export function useStopHorizontalTouchPropagation(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let decided = false;
    let isHorizontal = false;

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      decided = false;
      isHorizontal = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!decided) {
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - startX);
        const dy = Math.abs(touch.clientY - startY);
        if (dx + dy > 5) {
          decided = true;
          isHorizontal = dx > dy;
        }
      }
      // Only block propagation for horizontal swipes (protects picker scroll)
      // Vertical swipes propagate to parent for swipe-to-dismiss
      if (isHorizontal) e.stopPropagation();
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
    };
  }, [ref]);
}

/**
 * Tracks whether a scrollable container can scroll left/right.
 * Updates on scroll, resize, and content changes.
 */
export function useScrollIndicators(ref: React.RefObject<HTMLElement | null>) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    update();
    el.addEventListener('scroll', update, { passive: true });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ref, update]);

  return { canScrollLeft, canScrollRight };
}

/** Wraps a scrollable picker row with fade+arrow indicators on overflowing edges. */
export const ScrollIndicatorWrapper: React.FC<{
  canScrollLeft: boolean;
  canScrollRight: boolean;
  children: React.ReactNode;
}> = ({ canScrollLeft, canScrollRight, children }) => (
  <div className={styles.scrollableWrapper}>
    <div
      className={`${styles.scrollIndicator} ${styles.scrollIndicatorLeft} ${canScrollLeft ? styles.scrollIndicatorVisible : ''}`}
    >
      <ChevronLeftIcon sx={{ fontSize: 16 }} />
    </div>
    {children}
    <div
      className={`${styles.scrollIndicator} ${styles.scrollIndicatorRight} ${canScrollRight ? styles.scrollIndicatorVisible : ''}`}
    >
      <ChevronRightIcon sx={{ fontSize: 16 }} />
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Grade button — rendered separately from stars/tries for alignment */
/* ------------------------------------------------------------------ */

export type TickGradeButtonProps = {
  /** Current difficulty override (difficulty_id or undefined). */
  difficulty: number | undefined;
  /** Grade list for looking up the selected grade name. */
  displayedGrades: readonly { difficulty_id: number; difficulty_name: string; v_grade: string }[];
  /** Which control's picker is currently expanded. */
  expandedControl: ExpandedControl;
  /** Toggle a control's picker open/closed. */
  onExpandedControlChange: (control: ExpandedControl) => void;
};

/**
 * Standalone grade button — positioned independently from the
 * stars/tries controls so it can align with the consensus grade below.
 * Uses forwardRef so the parent can measure its position for picker scroll alignment.
 */
export const TickGradeButton = forwardRef<HTMLButtonElement, TickGradeButtonProps>(
  ({ difficulty, displayedGrades, expandedControl, onExpandedControlChange }, ref) => {
    const { t } = useTranslation('climbs');
    const isDark = useIsDarkMode();
    const { formatGrade, getGradeColor, loaded: gradeFormatLoaded } = useGradeFormat();

    const selectedGrade = difficulty ? displayedGrades.find((g) => g.difficulty_id === difficulty) : undefined;

    const displayDifficulty = selectedGrade?.difficulty_name ?? '';
    const formattedGrade = formatGrade(displayDifficulty);
    const gradeLabel = formattedGrade ?? (displayDifficulty || '—');
    const gradeColor = getGradeColor(displayDifficulty, isDark);

    return (
      <ButtonBase
        ref={ref}
        onClick={() => onExpandedControlChange(expandedControl === 'grade' ? null : 'grade')}
        aria-label={t('tick.controls.selectGrade')}
        aria-haspopup="listbox"
        aria-expanded={expandedControl === 'grade'}
        data-testid="quick-tick-grade"
        className={`${styles.gradeButton} ${expandedControl === 'grade' ? styles.active : ''}`}
        disableRipple={false}
      >
        {!gradeFormatLoaded ? (
          <Skeleton variant="rounded" width={24} height={14} />
        ) : (
          <span
            className={styles.gradeNumber}
            {...(gradeColor ? { style: { '--grade-color': gradeColor } as React.CSSProperties } : {})}
          >
            {gradeLabel}
          </span>
        )}
        <span className={styles.gradeByline}>{t('tick.controls.userByline')}</span>
      </ButtonBase>
    );
  },
);

TickGradeButton.displayName = 'TickGradeButton';

/* ------------------------------------------------------------------ */
/*  Stars + Tries controls                                            */
/* ------------------------------------------------------------------ */

export type TickControlsProps = {
  /** Current quality rating (1–5 or null). */
  quality: number | null;
  /** Current attempt count. */
  attemptCount: number;
  /** Which control's picker is currently expanded (null = none). */
  expandedControl: ExpandedControl;
  /** Toggle a control's picker open/closed. */
  onExpandedControlChange: (control: ExpandedControl) => void;
  /** Ref forwarded to the tries button for picker scroll alignment. */
  triesButtonRef?: React.RefObject<HTMLButtonElement | null>;
};

/**
 * Stars + Tries buttons. Grade is rendered separately via TickGradeButton
 * for alignment with the consensus grade in the queue bar.
 */
export const TickControls: React.FC<TickControlsProps> = ({
  quality,
  attemptCount,
  expandedControl,
  onExpandedControlChange,
  triesButtonRef,
}) => {
  const { t } = useTranslation('climbs');
  const attemptDisplay = String(attemptCount);

  const toggle = (control: 'stars' | 'tries') => {
    onExpandedControlChange(expandedControl === control ? null : control);
  };

  return (
    <>
      {/* Star selector */}
      <ButtonBase
        onClick={() => toggle('stars')}
        aria-label={`Quality: ${quality ?? 'none'}`}
        aria-haspopup="listbox"
        aria-expanded={expandedControl === 'stars'}
        data-testid="quick-tick-rating"
        className={`${styles.starButton} ${expandedControl === 'stars' ? styles.active : ''}`}
        disableRipple={false}
      >
        <StarIcon sx={{ fontSize: 14, color: quality ? themeTokens.colors.amber : 'inherit' }} />
        <span className={styles.starNumber}>{quality ?? '—'}</span>
        <span className={styles.starLabel}>{t('tick.controls.starsLabel')}</span>
      </ButtonBase>

      {/* Tries counter */}
      <ButtonBase
        ref={triesButtonRef}
        onClick={() => toggle('tries')}
        aria-label={`Tries: ${attemptDisplay}`}
        aria-haspopup="listbox"
        aria-expanded={expandedControl === 'tries'}
        data-testid="quick-tick-attempt"
        className={`${styles.attemptButton} ${expandedControl === 'tries' ? styles.active : ''}`}
        disableRipple={false}
      >
        <span className={styles.attemptNumber}>{attemptDisplay}</span>
        <span className={styles.attemptLabel}>{t('tick.controls.triesLabel')}</span>
      </ButtonBase>
    </>
  );
};

/* ------------------------------------------------------------------ */
/*  Inline picker sub-components — rendered by QuickTickBar above the */
/*  button row when a control is expanded.                            */
/* ------------------------------------------------------------------ */

export const InlineStarPicker: React.FC<{
  quality: number | null;
  onSelect: (value: number | null) => void;
  align?: 'start' | 'end';
  ariaLabel?: string;
  clearLabel?: string;
  clearText?: string;
  getStarLabel?: (value: number) => string;
}> = ({ quality, onSelect, align = 'end', ariaLabel, clearLabel, clearText, getStarLabel }) => {
  const { t } = useTranslation('climbs');
  const alignmentClassName = align === 'start' ? styles.pickerRowStart : styles.pickerRowEnd;

  return (
    <div
      className={`${styles.pickerRow} ${alignmentClassName}`}
      role="listbox"
      aria-label={ariaLabel ?? t('tick.controls.starRating')}
    >
      <ButtonBase
        onClick={() => onSelect(null)}
        className={`${styles.pickerItem} ${quality === null ? styles.pickerItemSelected : ''}`}
        aria-label={clearLabel ?? t('tick.controls.noRating')}
        aria-selected={quality === null}
        role="option"
      >
        <span className={clearText ? undefined : styles.pickerClear}>{clearText ?? '—'}</span>
      </ButtonBase>
      {[1, 2, 3, 4, 5].map((rating) => (
        <ButtonBase
          key={rating}
          onClick={() => onSelect(rating)}
          className={`${styles.pickerItem} ${rating === quality ? styles.pickerItemSelected : ''}`}
          aria-label={getStarLabel?.(rating) ?? t('tick.controls.starOption', { count: rating })}
          aria-selected={rating === quality}
          role="option"
        >
          <StarIcon
            sx={{
              fontSize: 22,
              color: rating <= (quality ?? 0) ? themeTokens.colors.amber : 'inherit',
              opacity: rating <= (quality ?? 0) ? 1 : 0.3,
            }}
          />
        </ButtonBase>
      ))}
    </div>
  );
};

export { InlineGradePicker } from '@/app/components/grade-picker/inline-grade-picker';
export type { InlineGradePickerProps } from '@/app/components/grade-picker/inline-grade-picker';

/** Options: 1–99. */
const ATTEMPT_OPTIONS: readonly number[] = Array.from({ length: 99 }, (_, i) => i + 1);

export const InlineTriesPicker: React.FC<{
  attemptCount: number;
  onSelect: (value: number) => void;
  /** Ref to the tries button for scroll alignment when attemptCount > 10. */
  triesButtonRef?: React.RefObject<HTMLButtonElement | null>;
}> = ({ attemptCount, onSelect, triesButtonRef }) => {
  const { t } = useTranslation('climbs');
  const containerRef = useRef<HTMLDivElement>(null);

  useStopHorizontalTouchPropagation(containerRef);
  const { canScrollLeft, canScrollRight } = useScrollIndicators(containerRef);

  // When attemptCount > 10, scroll so the selected try aligns above the tries button.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const triesButton = triesButtonRef?.current;
    if (!container || !triesButton || attemptCount <= 10) return;

    const selectedEl = container.querySelector(`[data-tries="${attemptCount}"]`) as HTMLElement | null;
    if (!selectedEl) return;

    const containerRect = container.getBoundingClientRect();
    const triesButtonRect = triesButton.getBoundingClientRect();

    const triesButtonCenterInContainer = triesButtonRect.left + triesButtonRect.width / 2 - containerRect.left;
    const selectedItemCenter = selectedEl.offsetLeft + selectedEl.offsetWidth / 2;

    const targetScrollLeft = selectedItemCenter - triesButtonCenterInContainer;
    const maxScroll = container.scrollWidth - container.clientWidth;
    container.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScroll));
  }, [attemptCount, triesButtonRef]);

  return (
    <ScrollIndicatorWrapper canScrollLeft={canScrollLeft} canScrollRight={canScrollRight}>
      <div
        ref={containerRef}
        className={styles.pickerRowScrollable}
        role="listbox"
        aria-label={t('tick.controls.attemptCount')}
        data-scrollable-picker
      >
        {ATTEMPT_OPTIONS.map((n) => (
          <ButtonBase
            key={n}
            data-tries={n}
            onClick={() => onSelect(n)}
            className={`${styles.pickerItem} ${n === attemptCount ? styles.pickerItemSelected : ''}`}
            aria-label={`${n} ${n === 1 ? 'try' : 'tries'}`}
            aria-selected={n === attemptCount}
            role="option"
          >
            <span className={styles.pickerNumber}>{n}</span>
          </ButtonBase>
        ))}
      </div>
    </ScrollIndicatorWrapper>
  );
};

/**
 * Board angle picker — same horizontally-scrollable shape as
 * InlineTriesPicker, but the option set comes from the board's static angle
 * table (ANGLES in @boardsesh/board-config) instead of a fixed numeric range,
 * since valid angles vary per board and aren't evenly spaced (MoonBoard).
 */
export const InlineAnglePicker: React.FC<{
  angles: readonly number[];
  angle: number;
  onSelect: (value: number) => void;
}> = ({ angles, angle, onSelect }) => {
  const { t } = useTranslation('climbs');
  const containerRef = useRef<HTMLDivElement>(null);

  useStopHorizontalTouchPropagation(containerRef);
  const { canScrollLeft, canScrollRight } = useScrollIndicators(containerRef);

  return (
    <ScrollIndicatorWrapper canScrollLeft={canScrollLeft} canScrollRight={canScrollRight}>
      <div
        ref={containerRef}
        className={styles.pickerRowScrollable}
        role="listbox"
        aria-label={t('tick.controls.angleSelector')}
        data-scrollable-picker
      >
        {angles.map((option) => (
          <ButtonBase
            key={option}
            onClick={() => onSelect(option)}
            className={`${styles.pickerItem} ${option === angle ? styles.pickerItemSelected : ''}`}
            aria-label={`${option}°`}
            aria-selected={option === angle}
            role="option"
          >
            <span className={styles.pickerNumber}>{option}°</span>
          </ButtonBase>
        ))}
      </div>
    </ScrollIndicatorWrapper>
  );
};
