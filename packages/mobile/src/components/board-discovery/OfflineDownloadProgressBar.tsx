// The thin bar under a downloading board's caption (issue #4311).
//
// Plain Views, no reanimated: the width is already throttled upstream (the
// engine emits at most one frame per 400 ms, and only when the rounded percent
// or the rounded megabyte figure actually moved), so animating it would add
// worklet cost for motion nobody would see.
//
// The track's height is reserved UNCONDITIONALLY — a row that only grows once
// the first frame lands would change its measured height inside the FlashList
// and jump the scroll position under the climber's thumb. An idle row renders
// the same box, transparent.

import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

const BAR_HEIGHT = 3;

type OfflineDownloadProgressBarProps = {
  /**
   * 0..1 fills the bar. `null` means indeterminate — the download is running but
   * has no trustworthy total, so the track shows with no fill rather than a
   * made-up width. `undefined` means no download at all: reserved space only.
   */
  fraction?: number | null;
};

function OfflineDownloadProgressBarComponent({ fraction }: OfflineDownloadProgressBarProps) {
  const { systemColors, brandColors } = useTheme();
  const isIdle = fraction === undefined;
  const filledPercent =
    fraction === null || fraction === undefined ? 0 : Math.round(Math.min(Math.max(fraction, 0), 1) * 100);

  return (
    <View
      style={[styles.track, { backgroundColor: isIdle ? 'transparent' : systemColors.tertiaryBackground }]}
      // Purely decorative: the caption beside it already carries the megabytes
      // and the percentage for a screen reader.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {filledPercent > 0 ? (
        <View style={[styles.fill, { backgroundColor: brandColors.primary, width: `${filledPercent}%` }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: BAR_HEIGHT,
    marginTop: spacing[1],
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: borderRadius.sm,
  },
});

export const OfflineDownloadProgressBar = memo(OfflineDownloadProgressBarComponent);
