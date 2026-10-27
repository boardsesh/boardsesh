// One block of a finished workout (#6903): a dot, the block's name with its
// tally ("4x4 at V4", "9 sent · 7 attempts"), the detail line under it ("4 reps
// × 4 sets"), a rep bar on a 4x4, and a chevron that opens the block's climbs.
//
// The header is one accessible element whose label says the whole row, "×"
// spelled out; when the block has climbs it is a button that shows or hides
// them. Each climb line is its own element.

import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { hapticSelection } from '../../../lib/haptics';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { RepGlyph, RepGlyphs } from './RepGlyphs';
import type { WorkoutClimbView, WorkoutStageView } from './types';
import {
  plannedReps,
  workoutBlockAccessibilityLabel,
  workoutBlockDetail,
  workoutBlockName,
  workoutClimbAccessibilityLabel,
  workoutClimbOutcome,
  workoutClimbStatus,
  workoutRepBar,
  workoutTally,
} from './workout-summary-format';

const MARKER_SIZE = 10;
/** The text column's inset from the row's leading edge: marker plus its gap. */
const TEXT_INSET = MARKER_SIZE + spacing[3];

type WorkoutBlockRowProps = {
  stage: WorkoutStageView;
  /** Draw a hairline under the row (every row but the card's last). */
  separator?: boolean;
  initiallyExpanded?: boolean;
};

export const WorkoutBlockRow = memo(function WorkoutBlockRow({
  stage,
  separator = false,
  initiallyExpanded = false,
}: WorkoutBlockRowProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const expandable = stage.climbs.length > 0;

  const toggle = useCallback(() => {
    hapticSelection();
    setExpanded((open) => !open);
  }, []);

  const name = workoutBlockName(stage, t);
  const detail = workoutBlockDetail(stage, t);
  const tally = workoutTally(stage.tally, t);
  const repBar = workoutRepBar(stage);
  const accessibilityLabel = workoutBlockAccessibilityLabel(stage, t);

  const header = (
    <>
      <View style={styles.headerRow}>
        <View style={[styles.marker, { backgroundColor: brandColors.primaryFill }]} />
        <View style={styles.text}>
          {/* Name and tally share a line while they fit; a long tally (German,
              large text) drops under the name instead of squeezing it. */}
          <View style={styles.nameRow}>
            <Text variant="body" style={styles.name} numberOfLines={2}>
              {name}
            </Text>
            {tally ? (
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.tally} numeric>
                {tally.text}
              </Text>
            ) : null}
          </View>
          <Text variant="footnote" color={systemColors.secondaryLabel} numeric>
            {detail.text}
          </Text>
        </View>
        {expandable ? (
          <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={14} color={systemColors.tertiaryLabel} />
        ) : null}
      </View>
      {repBar ? <RepBar sent={repBar.sent} total={repBar.total} /> : null}
    </>
  );

  return (
    <View
      style={[
        styles.row,
        separator ? { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator } : null,
      ]}
      testID="workout-block-row"
    >
      {expandable ? (
        <PressableSurface
          onPress={toggle}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={
            expanded ? t('mobile.workoutSummary.blockCollapseHint') : t('mobile.workoutSummary.blockExpandHint')
          }
          accessibilityState={{ expanded }}
          style={styles.header}
        >
          {header}
        </PressableSurface>
      ) : (
        <View accessible accessibilityLabel={accessibilityLabel} style={styles.header}>
          {header}
        </View>
      )}
      {expanded && expandable ? (
        <View style={styles.climbs}>
          {stage.climbs.map((climb) => (
            <WorkoutClimbLine key={climb.queueItemUuid} climb={climb} repsPerSet={stage.repsPerSet} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

/** One segment per planned rep, the sent ones filled. Decorative: the tally says it. */
const RepBar = memo(function RepBar({ sent, total }: { sent: number; total: number }) {
  const { brandColors, systemColors } = useTheme();
  return (
    <View style={styles.repBar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, index) => (
        <View
          // Segments are positional; the index is the identity.
          key={index}
          style={[
            styles.repSegment,
            { backgroundColor: index < sent ? brandColors.primaryFill : systemColors.tertiaryFill },
          ]}
        />
      ))}
    </View>
  );
});

/** A climb in an opened block: name and grade, then its reps ("3 of 4") or its outcome. */
export const WorkoutClimbLine = memo(function WorkoutClimbLine({
  climb,
  repsPerSet,
}: {
  climb: WorkoutClimbView;
  repsPerSet: number | null | undefined;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const isSets = typeof repsPerSet === 'number' && repsPerSet > 0;
  const status = workoutClimbStatus(climb, repsPerSet, t);
  const outcome = workoutClimbOutcome(climb);
  return (
    <View
      style={styles.climbLine}
      accessible
      accessibilityLabel={workoutClimbAccessibilityLabel(climb, repsPerSet, t)}
      testID="workout-climb-line"
    >
      <View style={styles.climbName}>
        <Text
          variant="subheadline"
          numberOfLines={1}
          style={styles.climbNameText}
          color={outcome === 'skipped' ? systemColors.secondaryLabel : systemColors.label}
        >
          {climb.name ?? t('detail.unknownClimb')}
        </Text>
        {climb.grade ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} numeric>
            {climb.grade}
          </Text>
        ) : null}
      </View>
      <View style={styles.climbStatus}>
        {isSets ? (
          <RepGlyphs reps={climb.reps} planned={plannedReps(climb, repsPerSet)} />
        ) : (
          <RepGlyph kind={outcome === 'skipped' ? 'unlogged' : outcome} />
        )}
        <Text variant="footnote" color={systemColors.secondaryLabel} numeric>
          {status.text}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing[3],
    gap: spacing[2],
  },
  header: {
    gap: spacing[2],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 44,
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing[3],
    rowGap: 2,
  },
  name: {
    flexShrink: 1,
    fontWeight: '600',
  },
  tally: {
    flexShrink: 1,
  },
  repBar: {
    flexDirection: 'row',
    gap: 3,
    marginStart: TEXT_INSET,
  },
  repSegment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
  },
  climbs: {
    marginStart: TEXT_INSET,
    gap: spacing[2],
  },
  climbLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 28,
  },
  climbName: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing[2],
  },
  climbNameText: {
    flexShrink: 1,
  },
  climbStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
