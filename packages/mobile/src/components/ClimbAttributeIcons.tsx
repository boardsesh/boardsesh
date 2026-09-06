import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CLIMB_CHARACTERISTICS,
  getMoonBoardMethod,
  isAnyFeet,
  isCampus,
  isNoKickboard,
  isNoMatch,
} from '@boardsesh/shared-schema';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';

type ClimbAttributeIconsProps = {
  /** Raw benchmark difficulty; > 0 marks a benchmark/classic climb. */
  benchmarkDifficulty?: string | number | null;
  /**
   * Climb characteristics; preferred source for no-match + MoonBoard method_* tokens.
   * When present, the no-match status is derived from it and `isNoMatch` is ignored.
   */
  characteristics?: string[] | null;
  /**
   * Fallback no-match flag for surfaces that carry the bool but not characteristics
   * (e.g. session-tick rows). Ignored when `characteristics` is provided.
   */
  isNoMatch?: boolean | null;
  /**
   * Glyph size; defaults to 14 to sit beside body-sized climb names. Applies to
   * the ICONS only — the text badges ride the shared `caption1` type scale so they
   * follow the per-UI-variant scale and Dynamic Type, rather than a fixed size
   * derived from this (#4883).
   */
  size?: number;
};

// Resolve the translated method label. Each branch uses a string-literal key so
// the i18n orphan/key analyzer can verify the catalog entries.
function methodLabel(characteristics: string[] | null | undefined, t: TFunction<'climbs'>): string | null {
  switch (getMoonBoardMethod(characteristics)) {
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS:
      return t('mobile.climbRow.method.footless');
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD:
      return t('mobile.climbRow.method.footlessKickboard');
    case CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD:
      return t('mobile.climbRow.method.noKickboard');
    default:
      return null;
  }
}

/**
 * Text badges for the freely-toggleable any-feet / no-kickboard / campus
 * characteristics — same reasoning as `methodLabel` above: no clean SF-Symbol
 * exists for any of them, so they render as text rather than joining the
 * icon-map.
 *
 * Any-feet is a DEPARTURE from the default on every board (feet normally follow
 * the marked holds), so it earns a badge in a compact row the same way campus
 * does. The play drawer's Woods header says both rules in full instead — see
 * `explicitClimbRules` — and suppresses this cluster's characteristics so the
 * two don't repeat each other.
 */
function extraCharacteristicLabels(characteristics: string[] | null | undefined, t: TFunction<'climbs'>): string[] {
  const labels: string[] = [];
  if (isCampus(characteristics)) labels.push(t('mobile.climbRow.campus'));
  else if (isAnyFeet(characteristics)) labels.push(t('mobile.climbRow.anyFeet'));
  if (isNoKickboard(characteristics)) labels.push(t('mobile.climbRow.noKickboard'));
  return labels;
}

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

  const benchmarkValue = benchmarkDifficulty != null ? Number(benchmarkDifficulty) : null;
  const isBenchmark = benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue);
  // Prefer the structured characteristics array; fall back to the legacy bool for
  // tick-sourced rows that carry the flag but not the full characteristics array.
  const isNoMatchClimb = characteristics != null ? isNoMatch(characteristics) : (isNoMatchFallback ?? false);
  const method = methodLabel(characteristics, t);
  const extraLabels = extraCharacteristicLabels(characteristics, t);

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
    marginLeft: 4,
    flexShrink: 0,
  },
  // No `textTransform: 'uppercase'` and no tracking: #4883 is about this cluster
  // shouting FOOTLESS / NO KB / CAMPUS beside a quietly-set no-match glyph. Sentence
  // case at the shared caption weight puts the two on the same footing, and the
  // catalog strings stay ABBREVIATED on purpose — see the PR body's width budget:
  // spelling "No KB" out in full costs the German row roughly three times the
  // badge width at Dynamic Type 1.5×, all of it taken from the climb's name.
  method: {
    marginLeft: 6,
    flexShrink: 0,
    fontWeight: '600',
  },
});
