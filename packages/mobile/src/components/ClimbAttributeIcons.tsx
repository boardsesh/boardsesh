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
import { resolveGradeErrorBadge } from '@boardsesh/logbook';
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
  /** board_climb_stats.difficulty_average − display_difficulty, for the
   *  "stiff/soft" grade-discrepancy badge. See resolveGradeErrorBadge. */
  difficultyError?: string | number | null;
  /** Ascent count backing `difficultyError` — gates the badge off for climbs
   *  with too few grade opinions to trust the average. */
  ascensionistCount?: number | null;
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
  if (isNoKickboard(characteristics)) labels.push(t('mobile.climbRow.noKickboard'));
  return labels;
}

/**
 * The "stiff/soft" grade-discrepancy badge label, or null when the crowd
 * average doesn't notably disagree with the display grade (or there aren't
 * enough ascents to trust it yet). Web parity: resolveGradeErrorLabel in
 * packages/web/app/lib/climb-method.ts — same shared resolveGradeErrorBadge.
 */
function gradeErrorLabel(
  difficultyError: string | number | null | undefined,
  ascensionistCount: number | null | undefined,
  t: TFunction<'climbs'>,
): string | null {
  const badge = resolveGradeErrorBadge(difficultyError, ascensionistCount);
  if (!badge) return null;
  return badge.direction === 'stiff' ? t('mobile.climbRow.gradeError.stiff') : t('mobile.climbRow.gradeError.soft');
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
  difficultyError,
  ascensionistCount,
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
  const gradeError = gradeErrorLabel(difficultyError, ascensionistCount, t);
  if (gradeError) extraLabels.push(gradeError);

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
        <Text style={[styles.method, { fontSize: size - 2, color: theme.systemColors.secondaryLabel }]}>{method}</Text>
      ) : null}
      {extraLabels.length > 0 ? (
        <Text style={[styles.method, { fontSize: size - 2, color: theme.systemColors.secondaryLabel }]}>
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
    flexShrink: 0,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
});
