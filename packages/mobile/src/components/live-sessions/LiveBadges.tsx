// Small visual pieces shared by the rail card and the board-sheet rows.

import { memo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { readableTextColor } from '@boardsesh/board-constants/readable-text-color';
import { Text } from '../Text';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/tokens';
import { LiveDot } from './LiveDot';
import type { LiveSessionColors } from './use-live-session-colors';

export const LIVE_ACTION_HEIGHT = 44;

/** A filled grade chip: grade colour fill, black (or white) ink, whichever reads. */
export const LiveGradeChip = memo(function LiveGradeChip({ rawGrade, label }: { rawGrade: string; label: string }) {
  const fill = getGradeColor(rawGrade) ?? DEFAULT_GRADE_COLOR;
  return (
    <View style={[styles.gradeChip, { backgroundColor: fill }]}>
      <Text
        variant="caption1"
        color={readableTextColor(fill)}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.bold}
      >
        {label}
      </Text>
    </View>
  );
});

/** The filled amber "Live" pill with the shared pulsing dot. */
export const LivePill = memo(function LivePill({ colors }: { colors: LiveSessionColors }) {
  const { t } = useTranslation('feed');
  return (
    <View style={[styles.livePill, { backgroundColor: colors.live }]}>
      <LiveDot color={colors.liveInk} size={6} />
      <Text
        variant="caption1"
        color={colors.liveInk}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.bold}
      >
        {t('mobile.liveSessions.live')}
      </Text>
    </View>
  );
});

type LiveActionPillProps = {
  label: string;
  colors: LiveSessionColors;
  /** Tinted (Join / Open / Invite on the rail) or filled (Join in the board sheet). */
  tone: 'tinted' | 'filled';
  style?: StyleProp<ViewStyle>;
};

/**
 * The label-only action capsule. Hidden from assistive tech on purpose: the
 * card or row around it is the button and already says what a tap does, and a
 * bare "Open" in the accessibility tree is exactly what UI tests match on.
 */
export const LiveActionPill = memo(function LiveActionPill({ label, colors, tone, style }: LiveActionPillProps) {
  const filled = tone === 'filled';
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.actionPill,
        filled
          ? { backgroundColor: colors.primaryFill, borderColor: colors.primaryFill }
          : { backgroundColor: colors.tintFill, borderColor: colors.tintBorder },
        style,
      ]}
    >
      <LiveActionLabel color={filled ? colors.onPrimary : colors.primary}>{label}</LiveActionLabel>
    </View>
  );
});

export function LiveActionLabel({ color, children }: { color: string; children: ReactNode }) {
  return (
    <Text variant="subheadline" color={color} numberOfLines={1} style={styles.semibold}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  semibold: { fontWeight: '600' },
  gradeChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    flexShrink: 0,
  },
  livePill: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingLeft: 7,
    paddingRight: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  actionPill: {
    height: LIVE_ACTION_HEIGHT,
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});

/** The capsule's box, for a real pressable Invite that must match Join exactly. */
export const liveActionPillStyle = styles.actionPill;
