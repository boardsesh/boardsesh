// The create-tick field stack. Always rendered inside `LogAscentSheet`, which
// owns the sheet chrome (header, scroll body, pinned action bar) and hands this
// component the form object from `useQuickTickForm`.
//
// Purely presentational: no state, no save path, no colours of its own. Every
// row is a `TickFormRow`, so the label seam and the control seam are the same
// two verticals here as in the edit sheet.
import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StarRating } from '../StarRating';
import { Text } from '../Text';
import { GradeSingleSelectRail } from '../grade';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import {
  TickCountRail,
  TickDateRow,
  TickFormRow,
  TickNoteField,
  TICK_RAIL_ROW_HEIGHT,
  TICK_RAIL_TRAIL_INSET,
} from '../tick';
import type { QuickTickForm } from './use-quick-tick-form';

const STAR_GLYPH_SIZE = 24;

export type QuickTickBarProps = {
  form: QuickTickForm;
};

export const QuickTickBar = React.memo(function QuickTickBar({ form }: QuickTickBarProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  // Resolved through the provider, never the static palette: these sheets sit
  // on an opaque ground and a module-scope colour always picks the light set.
  const { systemColors } = useTheme();

  const {
    climbUuid,
    tickState,
    comment,
    climbedAt,
    maximumClimbedAtDate,
    grades,
    consensusDifficultyId,
    onQualitySelect,
    onGradeSelect,
    onTriesSelect,
    onCommentChange,
    onClimbedAtChange,
    onFutureAdjusted,
  } = form;

  // StarRating speaks `number | undefined` and clears to 0; the tick state
  // stores `null` for "no rating", which is also the only value the save path
  // treats as unrated. Both cleared forms collapse to that null.
  const handleStarChange = useCallback(
    (rating: number | undefined) => onQualitySelect(rating ? rating : null),
    [onQualitySelect],
  );
  const starAccessibilityLabel = useCallback(
    (rating: number) => t('playView.tickBar.starRating', { count: rating }),
    [t],
  );

  return (
    // Row order is least-used at the top, most-used at the bottom, so the
    // common controls land in the thumb zone. Measured interaction rates:
    // tries 28%, stars 24%, grade 6.5%, note 1.4%, date/time <1% (#4163).
    // Note is the exception — rarely used, but kept off the save row's edge
    // because a text field there fat-fingers less than a picker.
    <>
      {/* Date and time on one row — two short, related values that don't each
          need a row of their own, separated by an `@`. Both fields commit
          through the same `onClimbedAtChange`, so touching either one pins
          the timestamp instead of logging a fresh save-time now. */}
      <TickFormRow label={tClimbs('mobile.tick.dateLabel')} testID="tick-row-date">
        <TickDateRow
          value={climbedAt}
          maximumDate={maximumClimbedAtDate}
          onChange={onClimbedAtChange}
          onFutureAdjusted={onFutureAdjusted}
          dateAccessibilityLabel={tClimbs('mobile.tick.dateLabel')}
          timeAccessibilityLabel={tClimbs('mobile.tick.timeLabel')}
        />
      </TickFormRow>

      <TickFormRow
        label={tClimbs('mobile.tick.gradeLabel')}
        bleed
        height={TICK_RAIL_ROW_HEIGHT}
        testID="tick-row-grade"
      >
        {grades ? (
          <GradeSingleSelectRail
            grades={grades}
            selectedDifficultyId={tickState.difficulty}
            consensusDifficultyId={consensusDifficultyId}
            onSelect={onGradeSelect}
            colorway="selection"
            contentInsetLeft={0}
            contentInsetRight={TICK_RAIL_TRAIL_INSET}
          />
        ) : null}
      </TickFormRow>

      {/* #4796 was filed because nothing told the climber this field was the
          lever — they graded a climb V10 and watched it keep saying V0. The
          label alone ("My grade") does not say what picking one DOES, so the
          consequence is spelled out once, permanently, right under the rail. */}
      <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.gradeHelp}>
        {tClimbs('mobile.tick.gradeHelp')}
      </Text>

      <TickFormRow label={tClimbs('mobile.tick.starsLabel')} testID="tick-row-stars">
        <StarRating
          value={tickState.quality ?? undefined}
          onChange={handleStarChange}
          size={STAR_GLYPH_SIZE}
          getAccessibilityLabel={starAccessibilityLabel}
        />
      </TickFormRow>

      <TickFormRow
        label={tClimbs('mobile.tick.triesLabel')}
        bleed
        height={TICK_RAIL_ROW_HEIGHT}
        testID="tick-row-tries"
      >
        <TickCountRail
          value={tickState.attemptCount}
          onSelect={onTriesSelect}
          resetKey={climbUuid}
          accessibilityLabel={tClimbs('mobile.tick.triesLabel')}
        />
      </TickFormRow>

      {/* `alignTop`: the note is the one control that grows well past the 56pt
          row beat, and a centred label floats ~31pt below the first line of
          the climber's own text (#4642). */}
      <TickFormRow label={tClimbs('mobile.tick.noteLabel')} alignTop showSeparator={false} testID="tick-row-note">
        <TickNoteField
          value={comment}
          onChangeText={onCommentChange}
          placeholder={tClimbs('mobile.tick.notePlaceholder')}
          accessibilityLabel={tClimbs('mobile.tick.noteAria')}
        />
      </TickFormRow>
    </>
  );
});

const styles = StyleSheet.create({
  gradeHelp: {
    // Sits under the grade rail's bleed row, so it needs the form's own
    // horizontal inset back rather than inheriting the rail's edge-to-edge one.
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
});
