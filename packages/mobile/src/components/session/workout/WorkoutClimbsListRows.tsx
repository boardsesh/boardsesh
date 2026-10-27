// The rows the session detail's grouped Climbs list adds around its tick rows
// (#6903): a section row per block (name, detail, tally), one row per 4x4 set
// with its rep glyphs, a dimmed row for a planned climb nobody logged, and the
// "Off plan" / crew section labels. Memoized: they live in a FlashList.

import { memo, useCallback } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { PressableSurface } from '../../PressableSurface';
import { ClimbListThumbnail } from '../../ClimbListThumbnail';
import { hapticSelection } from '../../../lib/haptics';
import { renderBoardToPlaylistConfig } from '../../../lib/playlists/board-details-for-playlist';
import { useTheme } from '../../../providers/theme-provider';
import { withAlpha } from '../../../theme/colors';
import { spacing } from '../../../theme/tokens';
import { RepGlyph, RepGlyphs } from './RepGlyphs';
import { workoutRowStacks } from './workout-layout';
import type { WorkoutClimbView, WorkoutStageView } from './types';
import {
  plannedReps,
  workoutBlockAccessibilityLabel,
  workoutBlockDetail,
  workoutBlockName,
  workoutClimbOutcome,
  workoutClimbStatus,
  workoutTally,
} from './workout-summary-format';

const LEADING_SIZE = 28;
const THUMBNAIL = { width: 44, height: 56 } as const;

/** A block's section row: "4x4 at V4 … 9 sent · 7 attempts", "4 reps × 4 sets" under it. */
export const WorkoutBlockSectionRow = memo(function WorkoutBlockSectionRow({ stage }: { stage: WorkoutStageView }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const tally = workoutTally(stage.tally, t);
  return (
    <View
      style={styles.section}
      accessible
      accessibilityRole="header"
      accessibilityLabel={workoutBlockAccessibilityLabel(stage, t)}
      testID="workout-block-section"
    >
      <View style={styles.sectionNameRow}>
        <Text variant="subheadline" style={styles.sectionName} numberOfLines={2}>
          {workoutBlockName(stage, t)}
        </Text>
        {tally ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionTally} numeric>
            {tally.text}
          </Text>
        ) : null}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} numeric>
        {workoutBlockDetail(stage, t).text}
      </Text>
    </View>
  );
});

/** "Off plan" or the crew: a plain section label with the count of its ticks ("2 ticks"). */
export const WorkoutListSectionLabel = memo(function WorkoutListSectionLabel({
  kind,
  count,
}: {
  kind: 'offPlan' | 'crew';
  count: number;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const title = kind === 'offPlan' ? t('mobile.workoutSummary.offPlan') : t('summary.crew');
  const ticks = t('mobile.workoutSummary.tickCount', { count });
  return (
    <View style={styles.section} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${ticks}`}>
      <View style={styles.sectionNameRow}>
        <Text variant="subheadline" style={styles.sectionName}>
          {title}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionTally} numeric>
          {ticks}
        </Text>
      </View>
    </View>
  );
});

/** One 4x4 set: the climb, "Set 2 · V4", its rep glyphs and "3 of 4". Opens the climb. */
export const WorkoutSetRow = memo(function WorkoutSetRow({
  climb,
  setNumber,
  repsPerSet,
  tick,
  onPress,
}: {
  climb: WorkoutClimbView;
  setNumber: number;
  repsPerSet: number;
  tick: SessionDetailTick | null;
  onPress: (tick: SessionDetailTick) => void;
}) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  // At large text sizes the reps go under the name, so the name keeps the width.
  const stacked = workoutRowStacks(useWindowDimensions().fontScale);
  const status = workoutClimbStatus(climb, repsPerSet, t);
  const setLabel = t('mobile.workoutSummary.setLabel', { number: setNumber });
  const name = climb.name ?? t('detail.unknownClimb');
  const subtitle = climb.grade ? `${setLabel} · ${climb.grade}` : setLabel;
  const accessibilityLabel = [name, setLabel, climb.grade, status.spoken].filter(Boolean).join(', ');

  const handlePress = useCallback(() => {
    if (!tick) return;
    hapticSelection();
    onPress(tick);
  }, [onPress, tick]);

  const reps = (
    <View style={stacked ? styles.trailingStacked : styles.trailing}>
      <RepGlyphs reps={climb.reps} planned={plannedReps(climb, repsPerSet)} />
      <Text variant="footnote" color={systemColors.secondaryLabel} numeric>
        {status.text}
      </Text>
    </View>
  );
  const content = (
    <>
      <ClimbThumbnailOrNumber climb={climb} number={setNumber} tint={brandColors.primary} />
      <View style={styles.rowText}>
        <Text variant="body" numberOfLines={2}>
          {name}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2} numeric>
          {subtitle}
        </Text>
        {stacked ? reps : null}
      </View>
      {stacked ? null : reps}
    </>
  );

  return (
    <View>
      {tick ? (
        <PressableSurface
          onPress={handlePress}
          feedback="opacity"
          opacityTo={0.7}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
          testID="workout-set-row"
        >
          {content}
        </PressableSurface>
      ) : (
        <View
          accessible
          accessibilityLabel={accessibilityLabel}
          style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
          testID="workout-set-row"
        >
          {content}
        </View>
      )}
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

/**
 * A planned climb with no tick to list: "Skipped" (dimmed), or, when its ticks
 * are hidden from this viewer, what the block's tally counted for it.
 */
export const WorkoutPlannedClimbRow = memo(function WorkoutPlannedClimbRow({ climb }: { climb: WorkoutClimbView }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const name = climb.name ?? t('detail.unknownClimb');
  const outcome = workoutClimbOutcome(climb);
  const isSkipped = outcome === 'skipped';
  const status = workoutClimbStatus(climb, null, t);
  return (
    <View>
      <View
        accessible
        accessibilityLabel={[name, climb.grade, status.spoken].filter(Boolean).join(', ')}
        style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
        testID={isSkipped ? 'workout-skipped-row' : 'workout-planned-row'}
      >
        <View style={styles.leading}>
          <RepGlyph kind={isSkipped ? 'unlogged' : outcome} />
        </View>
        <View style={styles.rowText}>
          <Text variant="body" color={isSkipped ? systemColors.secondaryLabel : systemColors.label} numberOfLines={2}>
            {name}
          </Text>
          {climb.grade ? (
            <Text variant="footnote" color={systemColors.tertiaryLabel} numeric>
              {climb.grade}
            </Text>
          ) : null}
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel} numeric>
          {status.text}
        </Text>
      </View>
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

/** The climb's board art when it can be drawn, else the set number on a tinted disc. */
function ClimbThumbnailOrNumber({ climb, number, tint }: { climb: WorkoutClimbView; number: number; tint: string }) {
  const config =
    climb.frames && climb.boardType
      ? renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard)
      : null;
  if (config && climb.frames) {
    return (
      <ClimbListThumbnail
        climbUuid={climb.climbUuid}
        frames={climb.frames}
        boardName={config.boardName}
        layoutId={config.layoutId}
        sizeId={config.sizeId}
        setIds={config.setIds.join(',')}
        mirrored={climb.isMirror ?? false}
        size={THUMBNAIL}
      />
    );
  }
  return (
    <View style={styles.leading}>
      <View style={[styles.disc, { backgroundColor: withAlpha(tint, 0.15) }]}>
        {/* The disc is a fixed size: the number grows only so far inside it. */}
        <Text variant="footnote" color={tint} style={styles.discText} numeric maxFontSizeMultiplier={1.2}>
          {number}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[5],
    paddingBottom: spacing[2],
    gap: 2,
  },
  sectionNameRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing[3],
    rowGap: 2,
  },
  sectionName: {
    flexShrink: 1,
    fontWeight: '600',
  },
  sectionTally: {
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    minHeight: 56,
  },
  leading: {
    width: LEADING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disc: {
    width: LEADING_SIZE,
    height: LEADING_SIZE,
    borderRadius: LEADING_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discText: {
    fontWeight: '700',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 2,
  },
  trailingStacked: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[2],
    rowGap: 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginStart: spacing[3] + LEADING_SIZE + spacing[3],
  },
});
