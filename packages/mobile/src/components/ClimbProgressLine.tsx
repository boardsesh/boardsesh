import { memo, useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { ASCENT_STATUS_ICON } from './ascent-status-icon';
import { ClimbRowReservedLine } from './ClimbRowReservedLine';
import { useTheme } from '../providers/theme-provider';
import { useClimbProgressStore } from '../lib/climb-progress-context';
import { useClimbProgress, useBoardClimbProgress } from '../hooks/use-climb-progress';
import { nowMs } from '../lib/clock';
import {
  climbProgressTokenBudget,
  describeClimbProgressRecency,
  PROGRESS_MAX_FONT_SCALE,
  type ClimbProgress,
} from '../lib/climb-progress';

export type ClimbRowProgressLeafProps = {
  boardName: import('@boardsesh/shared-schema').BoardName;
  climbUuid: string;
  angle: number;
  holdsRevisionNumber: number | null;
  supportsMirroring: boolean;
  showDirectionStatuses: boolean;
  reserveLine: boolean;
};

/** Only this leaf subscribes to progress; the row artwork remains memoized. */
export const ClimbProgressLine = memo(function ClimbProgressLine(props: ClimbRowProgressLeafProps) {
  const store = useClimbProgressStore();
  return store ? <ScopedProgressLine {...props} /> : <BoardProgressLine {...props} />;
});
const ScopedProgressLine = memo(function ScopedProgressLine(props: ClimbRowProgressLeafProps) {
  const progress = useClimbProgress(props.boardName, props.climbUuid, props.angle, props.holdsRevisionNumber);
  return <ClimbProgressView {...props} progress={progress} />;
});
const BoardProgressLine = memo(function BoardProgressLine(props: ClimbRowProgressLeafProps) {
  const progress = useBoardClimbProgress(props.boardName, props.climbUuid, props.angle, props.holdsRevisionNumber);
  return <ClimbProgressView {...props} progress={progress} />;
});

/** Shared with Settings: staged progress never reads auth or live logbooks. */
export const ClimbProgressView = memo(function ClimbProgressView({
  progress,
  supportsMirroring,
  showDirectionStatuses,
  reserveLine,
}: {
  progress: ClimbProgress | null;
  supportsMirroring: boolean;
  showDirectionStatuses: boolean;
  reserveLine: boolean;
}) {
  const { t, i18n } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const wording = useMemo(() => {
    if (!progress) return null;
    const outcome =
      progress.outcome.kind === 'attempt'
        ? t('mobile.climbRow.progress.tries', { count: progress.outcome.tries })
        : progress.outcome.sendCount > 1
          ? t('mobile.climbRow.progress.sentTimes', { count: progress.outcome.sendCount })
          : progress.outcome.kind === 'flash'
            ? t('mobile.climbRow.progress.flashed')
            : t('mobile.climbRow.progress.sent');
    const directions =
      supportsMirroring && showDirectionStatuses
        ? [
            { direction: 'original', label: tSession('mobile.logbook.originalTag'), status: progress.originalStatus },
            { direction: 'mirror', label: tSession('mobile.logbook.mirroredTag'), status: progress.mirrorStatus },
          ].filter((direction) => direction.status !== null)
        : [];
    let recency: string | null = null;
    if (progress.latestClimbedAtMs !== null) {
      // Read only when progress/locale/text size changes: no timer per row.
      const bucket = describeClimbProgressRecency(progress.latestClimbedAtMs, nowMs());
      recency =
        bucket.kind === 'today'
          ? t('mobile.climbRow.progress.today')
          : bucket.kind === 'days'
            ? t('mobile.climbRow.progress.daysAgo', { count: bucket.count })
            : new Date(bucket.ms).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' });
    }
    const directionLabels = directions.map(({ label, status }) =>
      t('mobile.climbRow.directionStatus', {
        direction: label,
        status: t(`mobile.climbRow.ascentStatus.${status}`),
      }),
    );
    return {
      outcome,
      directions,
      recency: climbProgressTokenBudget(fontScale) === 3 ? recency : null,
      // All directional statuses remain spoken when compact text drops labels.
      accessibilityLabel: [outcome, ...directionLabels, recency].filter(Boolean).join(' · '),
    };
  }, [progress, supportsMirroring, showDirectionStatuses, t, tSession, fontScale, i18n.language]);

  if (!progress || !wording)
    return reserveLine ? (
      <View testID="climb-row-personal-line">
        <ClimbRowReservedLine variant="footnote" maxFontSizeMultiplier={PROGRESS_MAX_FONT_SCALE} />
      </View>
    ) : null;
  return (
    <View
      testID="climb-row-personal-line"
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLabel={wording.accessibilityLabel}
    >
      <Icon name={ASCENT_STATUS_ICON[progress.status]} size={13} color={systemColors.label} />
      <Text
        variant="footnote"
        numberOfLines={1}
        maxFontSizeMultiplier={PROGRESS_MAX_FONT_SCALE}
        style={[styles.outcome, { color: systemColors.label }]}
      >
        {wording.outcome}
      </Text>
      {wording.directions.length ? (
        <View style={styles.directions}>
          {wording.directions.map(({ direction, label, status }) =>
            status ? (
              <View key={direction} style={styles.direction}>
                <Icon name={ASCENT_STATUS_ICON[status]} size={12} color={systemColors.secondaryLabel} />
                <Text
                  variant="caption2"
                  numberOfLines={1}
                  maxFontSizeMultiplier={PROGRESS_MAX_FONT_SCALE}
                  color={systemColors.secondaryLabel}
                  style={styles.directionLabel}
                >
                  {label}
                </Text>
              </View>
            ) : null,
          )}
        </View>
      ) : null}
      {wording.recency ? (
        <Text
          variant="footnote"
          numberOfLines={1}
          maxFontSizeMultiplier={PROGRESS_MAX_FONT_SCALE}
          color={systemColors.secondaryLabel}
          style={styles.recency}
        >
          · {wording.recency}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  outcome: { fontWeight: '600', flexShrink: 0 },
  directions: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0 },
  direction: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1, minWidth: 0 },
  directionLabel: { flexShrink: 1 },
  recency: { flexShrink: 1 },
});
