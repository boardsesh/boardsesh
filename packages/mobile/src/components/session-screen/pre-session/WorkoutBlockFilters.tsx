// One block's climb filters: min ascents, min rating, climb bias and, where the
// board has smaller sizes, tall or wide climbs only. A collapsed disclosure at
// the bottom of the block's fields, with a one-line summary, so the Record tab's
// block cards and the in-session "Add a block" sheet both get it.

import { useCallback, useMemo } from 'react';
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
import { SegmentedControl } from '../../SegmentedControl';
import { StarRating } from '../../StarRating';
import { SwitchRow } from '../../SwitchRow';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { selectByVariant } from '../../../theme/variants';
import { spacing } from '../../../theme/tokens';
import { Chip, generatorControlStyles } from './generator-controls';
import type { SizeFilterAvailability, WorkoutFilters } from './workout-blocks';

type Translate = (key: string, options?: Record<string, string | number>) => string;

function climbBiasLabel(value: ClimbBias, t: Translate): string {
  switch (value) {
    case 'unfamiliar':
      return t('mobile.session.preGeneratorClimbBiasUnfamiliar');
    case 'attempted':
      return t('mobile.session.preGeneratorClimbBiasAttempted');
    case 'any':
      return t('mobile.session.preGeneratorClimbBiasAny');
  }
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

/**
 * The closed disclosure's line, built like ClimbFilterSheet's refineSummary:
 * min ascents · stars · climb bias. Stars render as filled glyphs (a symbol, not
 * translatable copy); "Any" rating shows nothing so the line stays short.
 */
export function blockFiltersSummary(filters: WorkoutFilters, t: Translate): string {
  const parts: string[] = [
    t('mobile.session.preGeneratorMinAscentsOption', { value: formatMinAscentsFilterCount(filters.minAscents) }),
  ];
  const ratingValue = getMinRatingPickerValue(filters.minRating);
  if (ratingValue != null && ratingValue > 0) parts.push('★'.repeat(ratingValue));
  parts.push(climbBiasLabel(filters.climbBias, t));
  return parts.join(' · ');
}

type WorkoutBlockFiltersProps = {
  filters: WorkoutFilters;
  /** Which size filters the board offers; the others are not shown. */
  sizeFilters: SizeFilterAvailability;
  onFiltersChange: (patch: Partial<WorkoutFilters>) => void;
};

export function WorkoutBlockFilters({ filters, sizeFilters, onFiltersChange }: WorkoutBlockFiltersProps) {
  const { t } = useTranslation('session');
  const { systemColors, variant, m3 } = useTheme();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const { tall: showTallClimbsFilter, wide: showWideClimbsFilter } = sizeFilters;

  const minAscentsOptions = useMemo(() => {
    const baseOptions = getMinAscentsFilterOptions();
    if (baseOptions.includes(filters.minAscents)) return baseOptions;
    return [...baseOptions, filters.minAscents].sort((first, second) => first - second);
  }, [filters.minAscents]);
  const summary = useMemo(() => blockFiltersSummary(filters, t), [filters, t]);
  const climbBiasOptions = useMemo(
    () => CLIMB_BIAS_OPTIONS.map((climbBias) => ({ key: climbBias, label: climbBiasLabel(climbBias, t) })),
    [t],
  );
  const minRatingPickerValue = getMinRatingPickerValue(filters.minRating);
  const handleClimbBiasSelect = useCallback(
    (climbBias: ClimbBias) => onFiltersChange({ climbBias }),
    [onFiltersChange],
  );

  return (
    <CollapsibleSection title={t('mobile.session.preGeneratorClimbFilters')} summary={summary}>
      <View style={styles.body}>
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

        <View>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subsectionLabel}>
            {t('mobile.session.preGeneratorClimbBias')}
          </Text>
          <SegmentedControl
            options={climbBiasOptions}
            selectedKey={filters.climbBias}
            onSelect={handleClimbBiasSelect}
            accessibilityLabel={t('mobile.session.preGeneratorClimbBias')}
          />
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
  subsectionLabel: {
    marginBottom: spacing[2],
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
});
