import { type ReactNode, useMemo } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { getGradeTextColor } from '@boardsesh/play-view';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { RawGradeHighlight, RawStreaks, RawLastSendGap, RawLayoutPercentage } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { gradeBadgeColor } from './profile-chart-colors';
import { buildHeroGradient } from '../playlist/playlist-gradient';
import { spacing, borderRadius, opacity } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';
import { withAlpha } from '../../theme/colors';

const MATERIAL = { material: true, liquidGlass: false } as const;
const DOT = ' · ';

type HeroCeilingCardProps = {
  hardestSend: RawGradeHighlight | null;
  streaks: RawStreaks;
  lastSendGap: RawLastSendGap;
  totalAscents: number;
  layoutPercentages: RawLayoutPercentage[];
};

/**
 * "Your ceiling" — the grade-tinted hero. A V8 climber gets a V8 banner: the
 * gradient is built from the climber's own hardest-send colour, and the numeral
 * picks the contrast-correct text colour over it. iOS fills the whole card with
 * the gradient (Liquid Glass); Android lands the tint as a gradient band over a
 * flat M3 primaryContainer (M3 heroes are tonal, not glossy).
 */
export function HeroCeilingCard({
  hardestSend,
  streaks,
  lastSendGap,
  totalAscents,
  layoutPercentages,
}: HeroCeilingCardProps) {
  const { t } = useTranslation('profile');
  const { brandColors, m3 } = useTheme();
  const isMaterial = useVariantValue(MATERIAL);

  const gradeHex = hardestSend ? gradeBadgeColor(hardestSend.label) : brandColors.primary;
  const gradient = useMemo(() => buildHeroGradient(gradeHex), [gradeHex]);
  // Contrast colour for text sitting over the band (it deepens toward the bottom,
  // where the text sits, so resolve against the base grade hue).
  const onGradient = getGradeTextColor(gradeHex);
  // Body text sits over the gradient on Glass, over the tonal surface on Material.
  const bodyColor = isMaterial ? m3.onPrimaryContainer : onGradient;
  const dividerColor = isMaterial ? m3.outlineVariant : withAlpha(onGradient, 0.25);

  const boardNames = useMemo(() => {
    const seen: string[] = [];
    for (const layout of layoutPercentages) {
      const name = formatBoardDisplayName(layout.boardType);
      if (!seen.includes(name)) seen.push(name);
    }
    return seen.slice(0, 3).join(DOT);
  }, [layoutPercentages]);

  const footerParts = [t('dashboard.sends', { count: totalAscents })];
  if (boardNames) footerParts.push(boardNames);
  if (lastSendGap.isComeback && lastSendGap.comebackGapDays != null) {
    footerParts.push(t('dashboard.comeback', { count: lastSendGap.comebackGapDays }));
  } else if (lastSendGap.daysSinceLastSend != null && lastSendGap.daysSinceLastSend > 0) {
    footerParts.push(t('dashboard.daysSince', { count: lastSendGap.daysSinceLastSend }));
  }

  const gradeBlock: ReactNode = hardestSend ? (
    <>
      <View style={styles.gradeRow}>
        <Icon name="tick" size={18} color={onGradient} />
        <Text variant="largeTitle" color={onGradient}>
          {hardestSend.label}
        </Text>
      </View>
      <Text variant="footnote" color={onGradient} style={styles.caption}>
        {t('dashboard.hardestSend')}
      </Text>
    </>
  ) : (
    <Text variant="title2" color={onGradient}>
      {t('dashboard.noSendPrompt')}
    </Text>
  );

  return (
    <View style={[styles.card, isMaterial ? { backgroundColor: m3.primaryContainer } : styles.glassCard]}>
      {/* Glass: gradient fills the whole card. Material: only the header band. */}
      {isMaterial ? (
        <LinearGradient
          colors={gradient.colors}
          locations={gradient.locations}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.band}
        >
          {gradeBlock}
        </LinearGradient>
      ) : (
        <>
          <LinearGradient
            colors={gradient.colors}
            locations={gradient.locations}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.glassHeader}>{gradeBlock}</View>
        </>
      )}

      <View style={styles.body}>
        <View style={[styles.divider, { backgroundColor: dividerColor }]} />

        <StreakChip streaks={streaks} isMaterial={isMaterial} onGradient={onGradient} />

        {footerParts.length > 0 ? (
          <Text variant="footnote" color={bodyColor} style={styles.footer} numberOfLines={2}>
            {footerParts.join(DOT)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function StreakChip({
  streaks,
  isMaterial,
  onGradient,
}: {
  streaks: RawStreaks;
  isMaterial: boolean;
  onGradient: string;
}) {
  const { t } = useTranslation('profile');
  const { m3, brandColors } = useTheme();

  const hasStreak = streaks.currentWeeks > 0;
  const text = hasStreak
    ? `${t('dashboard.streakChip', { count: streaks.currentWeeks })}${streaks.longestWeeks > 0 ? DOT + t('dashboard.streakBest', { count: streaks.longestWeeks }) : ''}`
    : t('dashboard.noStreak');
  const textColor = isMaterial ? m3.onSecondaryContainer : onGradient;

  const inner = (
    <View style={styles.chipInner}>
      <Icon name="flame" size={14} color={brandColors.accent} />
      <Text variant="caption1" color={textColor} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );

  if (isMaterial) {
    return <View style={[styles.chip, { backgroundColor: m3.secondaryContainer }]}>{inner}</View>;
  }
  return (
    <GlassSurface glassEffectStyle="clear" borderRadius={borderRadius.full} style={styles.chip}>
      {inner}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  glassCard: {
    borderRadius: borderRadius.xl,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
    }),
  },
  band: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[5],
    paddingBottom: spacing[4],
  },
  glassHeader: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[5],
  },
  body: {
    paddingHorizontal: spacing[5],
    paddingBottom: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[2],
  },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  caption: {
    opacity: opacity.subtle,
    marginTop: spacing[1],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  chip: {
    alignSelf: 'flex-start',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    overflow: 'hidden',
  },
  chipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  footer: {
    opacity: opacity.subtle,
  },
});
