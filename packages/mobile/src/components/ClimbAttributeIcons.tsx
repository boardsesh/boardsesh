import { Text } from './Text';
import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { resolveClimbAttributes, type ClimbAttributeInput } from './climb-attribute-labels';

type ClimbAttributeIconsProps = ClimbAttributeInput & {
  /**
   * Glyph size; defaults to 14 to sit beside body-sized climb names. Applies to
   * the ICONS only — the text badges ride the shared `caption1` type scale so they
   * follow the per-UI-variant scale and Dynamic Type, rather than a fixed size
   * derived from this (#4883).
   */
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
  benchmarkDifficulty,
  characteristics,
  isNoMatch: isNoMatchFallback,
  size = 14,
}: ClimbAttributeIconsProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();

  // The play drawer's header stand-in speaks these same attributes
  // (`describeClimbAttributes`), so both read from one resolver.
  const { isBenchmark, isNoMatchClimb, method, extraLabels } = resolveClimbAttributes(
    { benchmarkDifficulty, characteristics, isNoMatch: isNoMatchFallback },
    t,
  );

  if (!isBenchmark && !isNoMatchClimb && !method && extraLabels.length === 0) return null;

  return (
    <>
      {isBenchmark ? (
        <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.benchmark')} style={styles.icon}>
          <Icon name="benchmark" size={size} color={theme.systemColors.secondaryLabel} />
        </View>
      ) : null}
      {isNoMatchClimb ? (
        <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.noMatch')} style={styles.icon}>
          <Icon name="no.match" size={size} color={theme.systemColors.secondaryLabel} />
        </View>
      ) : null}
      {method ? (
        <Text variant="caption1" color={theme.systemColors.secondaryLabel} style={styles.method}>
          {method}
        </Text>
      ) : null}
      {extraLabels.length > 0 ? (
        <Text variant="caption1" color={theme.systemColors.secondaryLabel} style={styles.method}>
          {extraLabels.join(' · ')}
        </Text>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  icon: {
    marginStart: 4,
    flexShrink: 0,
  },
  // No `textTransform: 'uppercase'` and no tracking: #4883 is about this cluster
  // shouting FOOTLESS / NO KB / CAMPUS beside a quietly-set no-match glyph. Sentence
  // case on the shared caption scale puts the two on the same footing, and the
  // catalog strings stay ABBREVIATED on purpose — see the PR body's width budget:
  // spelling "No KB" out in full costs the German row roughly three times the
  // badge width at Dynamic Type 1.5×, all of it taken from the climb's name.
  method: {
    marginStart: 6,
    flexShrink: 0,
    // Keep short attribute labels semibold while caption1 supplies size/line height.
    fontWeight: '600',
  },
});
