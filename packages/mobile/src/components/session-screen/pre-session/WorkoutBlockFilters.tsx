// One block's climb filters: climb bias, min ascents, min rating, Skip what I've
// sent, Skip what I've tried, Benchmarks only where the board has benchmarks
// and, where the board has smaller sizes, tall or wide climbs only. A collapsed
// disclosure at the bottom of the block's fields, with a summary line under its
// title, so the Record tab's block cards and the in-session "Add a block" sheet
// both get it.
//
// Climb bias comes first because it decides what else applies: Sent and Liked
// are lists you made by sending or hearting, where min ascents and min rating do
// not apply, so those two rows hide below it rather than jump the chip you
// tapped. Signed out there is no logbook to read, so every bias but Any is off.

import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  formatMinAscentsFilterCount,
  getMinAscentsFilterOptions,
  getMinRatingPickerValue,
} from '@boardsesh/climb-filters';
import { getTallWideScope } from '@boardsesh/board-constants';
import { CLIMB_BIAS_OPTIONS, type ClimbBias } from '@boardsesh/playlist-generator';
import type { BoardName } from '@boardsesh/shared-schema';
import { CollapsibleSection } from '../../CollapsibleSection';
import { StarRating } from '../../StarRating';
import { SwitchRow } from '../../SwitchRow';
import { Text } from '../../Text';
import { useAuth } from '../../../providers/auth-provider';
import { useTheme } from '../../../providers/theme-provider';
import { selectByVariant } from '../../../theme/variants';
import { spacing } from '../../../theme/tokens';
import { Chip, generatorControlStyles } from './generator-controls';
import type { SizeFilterAvailability, WorkoutFilters } from './workout-blocks';
import { biasCanSkipSent, biasCanSkipTried, biasDropsFloors, biasNeedsSignIn } from './workout-search-tiers';

type Translate = (key: string, options?: Record<string, string | number>) => string;

function climbBiasLabel(value: ClimbBias, t: Translate): string {
  switch (value) {
    case 'unfamiliar':
      return t('mobile.session.preGeneratorClimbBiasUnfamiliar');
    case 'attempted':
      return t('mobile.session.preGeneratorClimbBiasAttempted');
    case 'sent':
      return t('mobile.session.preGeneratorClimbBiasSent');
    case 'liked':
      return t('mobile.session.preGeneratorClimbBiasLiked');
    case 'any':
      return t('mobile.session.preGeneratorClimbBiasAny');
  }
}

/**
 * The bias a block's search applies, the one its chip row and summary show.
 * Signed out every bias falls back to Any (`fetchFilters`): the stored one is
 * kept for when the climber signs in, like a stored skip switch.
 */
function appliedClimbBias(filters: WorkoutFilters, isAuthenticated: boolean): ClimbBias {
  return isAuthenticated ? filters.climbBias : 'any';
}

/**
 * The line under the climb bias chips: which climbs the picked bias fills the
 * block from. Signed out every bias falls back to any climb (`fetchFilters`),
 * so the line says that instead, and why the other chips are off.
 */
function climbBiasDescription(value: ClimbBias, isAuthenticated: boolean, t: Translate): string {
  if (!isAuthenticated) return t('mobile.session.preGeneratorClimbBiasSignedOut');
  switch (value) {
    case 'unfamiliar':
      return t('mobile.session.preGeneratorClimbBiasUnfamiliarDescription');
    case 'attempted':
      return t('mobile.session.preGeneratorClimbBiasAttemptedDescription');
    case 'sent':
      return t('mobile.session.preGeneratorClimbBiasSentDescription');
    case 'liked':
      return t('mobile.session.preGeneratorClimbBiasLikedDescription');
    case 'any':
      return t('mobile.session.preGeneratorClimbBiasAnyDescription');
  }
}

/**
 * Whether a block's min ascents and min rating reach the search: not under Sent
 * or Liked (`biasDropsFloors`). Signed out the bias falls back to Any, so they
 * apply again.
 */
export function blockAppliesFloors(filters: WorkoutFilters, isAuthenticated: boolean): boolean {
  return !biasDropsFloors(appliedClimbBias(filters, isAuthenticated));
}

/** Which size filters a board offers. Neither until the board is known. */
export function sizeFilterAvailability(
  boardName: BoardName | null,
  layoutId: number | null,
  sizeId: number | null,
): SizeFilterAvailability {
  const scope =
    boardName != null && layoutId != null && sizeId != null ? getTallWideScope(boardName, layoutId, sizeId) : null;
  return { tall: scope?.hasShorter ?? false, wide: scope?.hasNarrower ?? false };
}

// Spray walls have no benchmarks (#5960), and the Woods, SoILL and Touchstone
// catalogues hold none (docs/workout-catalogue-depth.md), so a Benchmarks only
// block there could only come back empty.
const BOARDS_WITHOUT_BENCHMARKS: ReadonlySet<BoardName> = new Set<BoardName>(['spray', 'woods', 'soill', 'touchstone']);

/**
 * Whether a block on this board shows Benchmarks only: not on a board without
 * benchmarks, nor while the board is unknown. A switch already on stays, so a
 * filter picked on another board can still be turned off (the filter sheet's
 * Collection keeps Benchmarks on a spray wall the same way).
 */
export function offersBenchmarksOnly(boardName: BoardName | null, filters: WorkoutFilters): boolean {
  if (filters.onlyBenchmarks) return true;
  return boardName !== null && !BOARDS_WITHOUT_BENCHMARKS.has(boardName);
}

/** Whether a block's Skip what I've tried applies: on, and under a bias it can apply to. */
function skipsTried(filters: WorkoutFilters): boolean {
  return filters.skipTried === true && biasCanSkipTried(filters.climbBias);
}

/** Whether a block's Skip what I've sent applies: on, and under a bias it can apply to. */
function skipsSent(filters: WorkoutFilters): boolean {
  return filters.skipSent === true && biasCanSkipSent(filters.climbBias);
}

/**
 * The closed disclosure's line, built like ClimbFilterSheet's refineSummary:
 * min ascents · stars · climb bias, then Skip tried or Skip sent and Benchmarks
 * when on. Skip tried leaves out sent climbs too, so it stands in for Skip sent.
 * Stars render as filled glyphs (a symbol, not translatable copy); "Any" rating
 * shows nothing so the line stays short. A Sent or Liked block shows no min
 * ascents or stars, which it does not apply. Signed out it names the bias the
 * search applies, Any, with its floors and no skip switch.
 */
export function blockFiltersSummary(filters: WorkoutFilters, t: Translate, isAuthenticated = true): string {
  const parts: string[] = [];
  if (blockAppliesFloors(filters, isAuthenticated)) {
    parts.push(
      t('mobile.session.preGeneratorMinAscentsOption', { value: formatMinAscentsFilterCount(filters.minAscents) }),
    );
    const ratingValue = getMinRatingPickerValue(filters.minRating);
    if (ratingValue != null && ratingValue > 0) parts.push('★'.repeat(ratingValue));
  }
  parts.push(climbBiasLabel(appliedClimbBias(filters, isAuthenticated), t));
  if (isAuthenticated && skipsTried(filters)) parts.push(t('mobile.session.preGeneratorSkipTriedSummary'));
  else if (isAuthenticated && skipsSent(filters)) parts.push(t('mobile.session.preGeneratorSkipSentSummary'));
  if (filters.onlyBenchmarks) parts.push(t('mobile.session.preGeneratorOnlyBenchmarksSummary'));
  return parts.join(' · ');
}

function skipSentDescription(filters: WorkoutFilters, isAuthenticated: boolean, t: Translate): string {
  if (!isAuthenticated) return t('mobile.session.preGeneratorSkipSentSignedOut');
  if (!biasCanSkipSent(filters.climbBias)) return t('mobile.session.preGeneratorSkipNotWithSent');
  return t('mobile.session.preGeneratorSkipSentDescription');
}

function skipTriedDescription(filters: WorkoutFilters, isAuthenticated: boolean, t: Translate): string {
  if (!isAuthenticated) return t('mobile.session.preGeneratorSkipTriedSignedOut');
  if (filters.climbBias === 'sent') return t('mobile.session.preGeneratorSkipNotWithSent');
  if (!biasCanSkipTried(filters.climbBias)) return t('mobile.session.preGeneratorSkipTriedAttempted');
  return t('mobile.session.preGeneratorSkipTriedDescription');
}

type WorkoutBlockFiltersProps = {
  filters: WorkoutFilters;
  /** The board the block's climbs come from: Benchmarks only shows where it has benchmarks. */
  boardName: BoardName | null;
  /** Which size filters the board offers; the others are not shown. */
  sizeFilters: SizeFilterAvailability;
  onFiltersChange: (patch: Partial<WorkoutFilters>) => void;
};

export function WorkoutBlockFilters({ filters, boardName, sizeFilters, onFiltersChange }: WorkoutBlockFiltersProps) {
  const { t } = useTranslation('session');
  const { systemColors, variant, m3 } = useTheme();
  // The climb bias and the skip switches read your logbook, so they need an
  // account. Signed out the search never sees them (`fetchFilters`): the chips
  // show Any picked with the others off, and the switches show off. Skip what
  // I've tried is off under Attempted and Sent, which pick tried or sent
  // climbs, and Skip what I've sent under Sent.
  const { isAuthenticated } = useAuth();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const { tall: showTallClimbsFilter, wide: showWideClimbsFilter } = sizeFilters;
  const showBenchmarksFilter = offersBenchmarksOnly(boardName, filters);
  const shownClimbBias = appliedClimbBias(filters, isAuthenticated);
  const showFloors = blockAppliesFloors(filters, isAuthenticated);
  const canSkipSent = isAuthenticated && biasCanSkipSent(filters.climbBias);
  const canSkipTried = isAuthenticated && biasCanSkipTried(filters.climbBias);

  const minAscentsOptions = useMemo(() => {
    const baseOptions = getMinAscentsFilterOptions();
    if (baseOptions.includes(filters.minAscents)) return baseOptions;
    return [...baseOptions, filters.minAscents].sort((first, second) => first - second);
  }, [filters.minAscents]);
  const title = t('mobile.session.preGeneratorClimbFilters');
  // Signed out a stored bias or skip switch does nothing, so the line shows Any
  // and leaves the switch out.
  const summary = useMemo(() => blockFiltersSummary(filters, t, isAuthenticated), [filters, isAuthenticated, t]);
  // While closed, the title with the line under it, wrapping across the card's
  // width. Beside the title on one line it cut off at "Skip…" on a 393 pt phone
  // once Skip sent or Benchmarks was on, even in English.
  const collapsedHeader = useMemo(
    () => (
      <View style={styles.collapsedHeader}>
        <Text variant="headline">{title}</Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {summary}
        </Text>
      </View>
    ),
    [summary, systemColors.secondaryLabel, title],
  );
  const minRatingPickerValue = getMinRatingPickerValue(filters.minRating);
  const climbBiasGroupLabel = t('mobile.session.preGeneratorClimbBias');

  return (
    <CollapsibleSection title={title} summary={collapsedHeader} hideTitleWhenCollapsed>
      <View style={styles.body}>
        {/* Chips, not a segmented control: five biases cut "Unfamiliar" short in
            a segment on a 393 pt phone, and longer in French and Spanish. */}
        <View>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subsectionLabel}>
            {climbBiasGroupLabel}
          </Text>
          <View style={generatorControlStyles.chipRow}>
            {CLIMB_BIAS_OPTIONS.map((climbBias) => {
              const label = climbBiasLabel(climbBias, t);
              return (
                <Chip
                  key={climbBias}
                  label={label}
                  selected={shownClimbBias === climbBias}
                  disabled={!isAuthenticated && biasNeedsSignIn(climbBias)}
                  onPress={() => onFiltersChange({ climbBias })}
                  accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                    group: climbBiasGroupLabel,
                    value: label,
                  })}
                />
              );
            })}
          </View>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.biasDescription}>
            {climbBiasDescription(filters.climbBias, isAuthenticated, t)}
          </Text>
        </View>

        {showFloors ? (
          <>
            <View>
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subsectionLabel}>
                {t('mobile.session.preGeneratorMinAscents')}
              </Text>
              <View style={generatorControlStyles.chipRow}>
                {minAscentsOptions.map((minAscents) => {
                  const label = t('mobile.session.preGeneratorMinAscentsOption', {
                    value: formatMinAscentsFilterCount(minAscents),
                  });
                  return (
                    <Chip
                      key={minAscents}
                      label={label}
                      selected={filters.minAscents === minAscents}
                      onPress={() => onFiltersChange({ minAscents })}
                      accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                        group: t('mobile.session.preGeneratorMinAscents'),
                        value: label,
                      })}
                    />
                  );
                })}
              </View>
            </View>

            <View>
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subsectionLabel}>
                {t('mobile.session.preGeneratorMinRating')}
              </Text>
              <View style={styles.ratingRow}>
                <Chip
                  label={t('mobile.session.preGeneratorAny')}
                  selected={minRatingPickerValue == null}
                  onPress={() => onFiltersChange({ minRating: 0 })}
                  accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                    group: t('mobile.session.preGeneratorMinRating'),
                    value: t('mobile.session.preGeneratorAny'),
                  })}
                />
                <StarRating
                  value={minRatingPickerValue ?? undefined}
                  onChange={(rating) => onFiltersChange({ minRating: rating ?? 0 })}
                  accessibilityHint={t('mobile.session.preGeneratorMinRatingStarHint')}
                  getAccessibilityLabel={(rating, selected) =>
                    t(
                      selected
                        ? 'mobile.session.preGeneratorMinRatingStarSelectedAccessibilityLabel'
                        : 'mobile.session.preGeneratorMinRatingStarAccessibilityLabel',
                      { count: rating },
                    )
                  }
                />
              </View>
            </View>
          </>
        ) : null}

        <View
          style={[
            generatorControlStyles.groupedCard,
            { backgroundColor: isMaterial ? m3.surfaceVariant : systemColors.fill },
          ]}
        >
          <SwitchRow
            label={t('mobile.session.preGeneratorSkipSentLabel')}
            description={skipSentDescription(filters, isAuthenticated, t)}
            wrapDescription
            value={canSkipSent && filters.skipSent === true}
            disabled={!canSkipSent}
            onValueChange={(skipSent) => onFiltersChange({ skipSent })}
          />
          <View
            style={[
              generatorControlStyles.groupDivider,
              { backgroundColor: isMaterial ? m3.outlineVariant : systemColors.separator },
            ]}
          />
          <SwitchRow
            label={t('mobile.session.preGeneratorSkipTriedLabel')}
            description={skipTriedDescription(filters, isAuthenticated, t)}
            wrapDescription
            value={canSkipTried && filters.skipTried === true}
            disabled={!canSkipTried}
            onValueChange={(skipTried) => onFiltersChange({ skipTried })}
          />
          {showBenchmarksFilter ? (
            <>
              <View
                style={[
                  generatorControlStyles.groupDivider,
                  { backgroundColor: isMaterial ? m3.outlineVariant : systemColors.separator },
                ]}
              />
              <SwitchRow
                label={t('mobile.session.preGeneratorOnlyBenchmarksLabel')}
                description={t('mobile.session.preGeneratorOnlyBenchmarksDescription')}
                wrapDescription
                value={filters.onlyBenchmarks === true}
                onValueChange={(onlyBenchmarks) => onFiltersChange({ onlyBenchmarks })}
              />
            </>
          ) : null}
        </View>

        {showTallClimbsFilter || showWideClimbsFilter ? (
          <View
            style={[
              generatorControlStyles.groupedCard,
              { backgroundColor: isMaterial ? m3.surfaceVariant : systemColors.fill },
            ]}
          >
            {showTallClimbsFilter ? (
              <SwitchRow
                label={t('mobile.session.preGeneratorTallClimbsLabel')}
                description={t('mobile.session.preGeneratorTallClimbsDescription')}
                value={filters.onlyTallClimbs}
                onValueChange={(onlyTallClimbs) => onFiltersChange({ onlyTallClimbs })}
              />
            ) : null}
            {showTallClimbsFilter && showWideClimbsFilter ? (
              <View
                style={[
                  generatorControlStyles.groupDivider,
                  { backgroundColor: isMaterial ? m3.outlineVariant : systemColors.separator },
                ]}
              />
            ) : null}
            {showWideClimbsFilter ? (
              <SwitchRow
                label={t('mobile.session.preGeneratorWideClimbsLabel')}
                description={t('mobile.session.preGeneratorWideClimbsDescription')}
                value={filters.onlyWideClimbs}
                onValueChange={(onlyWideClimbs) => onFiltersChange({ onlyWideClimbs })}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </CollapsibleSection>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing[4],
  },
  collapsedHeader: {
    gap: spacing[1],
  },
  subsectionLabel: {
    marginBottom: spacing[2],
  },
  biasDescription: {
    marginTop: spacing[2],
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
});
