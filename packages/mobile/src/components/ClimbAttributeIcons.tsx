import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';

type ClimbAttributeIconsProps = {
  /** True when the climb disallows matching both hands on a hold. */
  isNoMatch?: boolean | null;
  /** Raw benchmark difficulty; > 0 marks a benchmark/classic climb. */
  benchmarkDifficulty?: string | number | null;
  /** Glyph size; defaults to 14 to sit beside body-sized climb names. */
  size?: number;
};

/**
 * Grey glyph cluster for a climb's intrinsic attributes, rendered inline after a
 * climb name (web parity: `packages/web/.../climb-card/climb-icons.tsx`).
 * Order matches web — © benchmark/classic, then ⊘ no-match. Monochrome so it
 * never competes with the colour-coded grade, and colour-blind-safe by shape.
 * Returns null when neither attribute applies (the common case).
 */
export const ClimbAttributeIcons = memo(function ClimbAttributeIcons({
  isNoMatch,
  benchmarkDifficulty,
  size = 14,
}: ClimbAttributeIconsProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();

  const benchmarkValue = benchmarkDifficulty != null ? Number(benchmarkDifficulty) : null;
  const isBenchmark = benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue);

  if (!isBenchmark && !isNoMatch) return null;

  return (
    <>
      {isBenchmark ? (
        <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.benchmark')} style={styles.icon}>
          <Icon name="benchmark" size={size} color={theme.systemColors.secondaryLabel} />
        </View>
      ) : null}
      {isNoMatch ? (
        <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.noMatch')} style={styles.icon}>
          <Icon name="no.match" size={size} color={theme.systemColors.secondaryLabel} />
        </View>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  icon: {
    marginLeft: 4,
    flexShrink: 0,
  },
});
