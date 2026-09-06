import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
  /** Glyph size; defaults to 14 to sit beside body-sized climb names. */
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
  // `no_kickboard` and `method_no_kickboard` are independent tokens, and a climb
  // can carry both. The method badge already says it, and in en/es/fr the two
  // strings are word-for-word identical, so rendering both printed "No KB  No
  // KB". Only German distinguishes them (Ohne KB vs Ohne FL), and there the
  // method spelling is the one that belongs next to the other method badges.
  if (
    isNoKickboard(characteristics) &&
    getMoonBoardMethod(characteristics) !== CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD
  ) {
    labels.push(t('mobile.climbRow.noKickboard'));
  }
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
        <Text
          numberOfLines={1}
          style={[styles.method, { fontSize: size - 2, color: theme.systemColors.secondaryLabel }]}
        >
          {method}
        </Text>
      ) : null}
      {extraLabels.length > 0 ? (
        <Text
          numberOfLines={1}
          style={[styles.method, { fontSize: size - 2, color: theme.systemColors.secondaryLabel }]}
        >
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
  method: {
    marginLeft: 6,
    // Shrink these before the climb name does. They were `flexShrink: 0` while
    // the name was `flexShrink: 1`, so the row's unique identifier absorbed all
    // the truncation to protect an optional rule badge — and a MoonBoard climb
    // carrying several of them pushed ~95pt of unshrinkable text through the
    // name and on over the grade, since nothing in the row clips.
    flexShrink: 1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
});
