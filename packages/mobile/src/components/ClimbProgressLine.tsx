import React, { useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { ASCENT_STATUS_ICON } from './ascent-status-icon';
import { useTheme } from '../providers/theme-provider';
import { useClimbProgress } from '../hooks/use-climb-progress';
import { climbProgressTokenBudget, describeClimbProgressRecency, PROGRESS_MAX_FONT_SCALE } from '../lib/climb-progress';

/**
 * Leading glyph size. Smaller than the trailing 16pt status marker on purpose —
 * it sits on a footnote line, and matches the 13pt `people` glyph the grade
 * column already uses for its inline marker.
 */
const GLYPH_SIZE = 13;

/**
 * Line 2 of the rich tier's centre column: what YOU have done on this climb.
 *
 * The row's widest slot has always belonged to the crowd (`66k sends · 3.2★ ·
 * jwebxl`), with everything personal squeezed into 16pt glyphs at the edge — so
 * the row could not answer "where am I on this climb?" (#4796). This line answers
 * it in up to three tokens: what you did, which way round (#4801's climbs-list
 * half), and how long ago.
 *
 * It outranks the crowd line by COLOUR and WEIGHT, never by size: `label` at 600
 * against the crowd line's dimmed `footnote`. Size tiering would be a no-op on
 * Android, where `caption1` and `caption2` are byte-identical in the M3 scale
 * (11/16, weight 500).
 *
 * Its own `React.memo` boundary over primitive props, for the same reason as
 * `AscentStatusGlyph` and `ClimbPlaylistChips`: this and the status glyph are the
 * ONLY parts of the row subscribed to the logbook, so a tick write re-renders one
 * text line rather than the thumbnail, the name and the grade. Hoisting
 * `useClimbProgress` into `ClimbListItemContent` would re-render every visible
 * row's artwork on every logbook merge — the regression the climbs-search
 * redesign shipped once already.
 *
 * Renders null when the climber has no history with the climb, which is the
 * majority case and every signed-out row.
 */
export const ClimbProgressLine = React.memo(function ClimbProgressLine({
  climbUuid,
  angle,
}: {
  climbUuid: string;
  angle: number;
}) {
  const { t, i18n } = useTranslation('climbs');
  const { systemColors } = useTheme();
  // Dynamic Type governs how many tokens fit on one line. `fontScale` is a real
  // Dynamic Type multiplier on both platforms (iOS reads it off
  // RCTAccessibilityManager.multiplier), and it changes about as often as the
  // user visits Settings, so the subscription costs a mounted row nothing.
  const { fontScale } = useWindowDimensions();
  const progress = useClimbProgress(climbUuid, angle);

  const label = useMemo(() => {
    if (!progress) return null;

    const outcome =
      progress.outcome.kind === 'flash'
        ? t('mobile.climbRow.progress.flashed')
        : progress.outcome.kind === 'send'
          ? progress.outcome.sendCount > 1
            ? t('mobile.climbRow.progress.sentTimes', { count: progress.outcome.sendCount })
            : t('mobile.climbRow.progress.sent')
          : t('mobile.climbRow.progress.tries', { count: progress.outcome.tries });

    // `original` is deliberately absent: it is the default orientation, so a
    // token on nearly every row would carry no information at all.
    const mirror =
      progress.mirror === 'both'
        ? t('mobile.climbRow.progress.bothWays')
        : progress.mirror === 'mirror'
          ? t('mobile.climbRow.progress.mirror')
          : null;

    let recency: string | null = null;
    if (progress.latestClimbedAtMs !== null) {
      const bucket = describeClimbProgressRecency(progress.latestClimbedAtMs, Date.now());
      recency =
        bucket.kind === 'today'
          ? t('mobile.climbRow.progress.today')
          : bucket.kind === 'days'
            ? t('mobile.climbRow.progress.daysAgo', { count: bucket.count })
            : new Date(bucket.ms).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' });
    }

    const tokens = [outcome, mirror, recency].filter((token): token is string => token != null);
    return tokens.slice(0, climbProgressTokenBudget(fontScale)).join(' · ');
  }, [progress, fontScale, t, i18n.language]);

  if (!progress || label === null) return null;

  return (
    // One grouped utterance, so screen readers speak "Flashed · mirror · today"
    // rather than announcing the glyph and the text as two separate elements.
    <View style={styles.row} accessible accessibilityRole="text" accessibilityLabel={label}>
      <Icon name={ASCENT_STATUS_ICON[progress.status]} size={GLYPH_SIZE} color={systemColors.label} />
      <Text
        variant="footnote"
        numberOfLines={1}
        maxFontSizeMultiplier={PROGRESS_MAX_FONT_SCALE}
        style={[styles.text, { color: systemColors.label }]}
      >
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  text: {
    // Weight, not size, is what puts this line above the crowd line — see the
    // component comment for why size tiering would be a no-op on Android.
    fontWeight: '600',
    flexShrink: 1,
  },
});
