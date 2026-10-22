import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { getTallWideScope } from '@boardsesh/board-constants';
import {
  formatMinAscentsFilterCount,
  getMinAscentsFilterOptions,
  getMinRatingPickerValue,
} from '@boardsesh/climb-filters';
import { CLIMB_BIAS_OPTIONS, type ClimbBias } from '@boardsesh/playlist-generator';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { CollapsibleSection } from '../../CollapsibleSection';
import { StarRating } from '../../StarRating';
import { SwitchRow } from '../../SwitchRow';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { selectByVariant } from '../../../theme/variants';
import { spacing } from '../../../theme/tokens';
import { Chip, generatorControlStyles } from './generator-controls';
import { hasWorkoutBlocks, updateFilters, type GeneratorSelection, type WorkoutFilters } from './workout-blocks';
import { WorkoutBlockList } from './WorkoutBlockList';

export type { GeneratorSelection } from './workout-blocks';

type GeneratorPickerCardProps = {
  boardName: BoardName | null;
  layoutId: number | null;
  sizeId: number | null;
  /** Board angle, forwarded to the `Workout Generator Opened` event to match web. */
  angle: number | null;
  selection: GeneratorSelection;
  onChange: (selection: GeneratorSelection) => void;
  /** Scrolls a block card that was just added or opened clear of the bottom chrome. */
  onRevealBlock?: (cardView: View) => void;
};

function climbBiasLabel(value: ClimbBias, t: (key: string) => string): string {
  switch (value) {
    case 'unfamiliar':
      return t('mobile.session.preGeneratorClimbBiasUnfamiliar');
    case 'attempted':
      return t('mobile.session.preGeneratorClimbBiasAttempted');
    case 'any':
      return t('mobile.session.preGeneratorClimbBiasAny');
  }
}

/**
 * The Workout section of the Record tab. With no blocks the climber picks every
 * climb; each block they add (a warm-up or a workout type) pre-fills the queue
 * from the shared `@boardsesh/playlist-generator`, in the order the blocks run.
 * Below the blocks, the climb filters (min ascents, min rating, climb bias,
 * tall/wide) are set once for every block and start collapsed.
 */
export function GeneratorPickerCard({
  boardName,
  layoutId,
  sizeId,
  angle,
  selection,
  onChange,
  onRevealBlock,
}: GeneratorPickerCardProps) {
  const { t } = useTranslation('session');
  const { systemColors, variant, m3 } = useTheme();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const { filters } = selection;

  const tallWideScope =
    boardName != null && layoutId != null && sizeId != null ? getTallWideScope(boardName, layoutId, sizeId) : null;
  const showTallClimbsFilter = tallWideScope?.hasShorter ?? false;
  const showWideClimbsFilter = tallWideScope?.hasNarrower ?? false;

  useEffect(() => {
    const shouldClearTallClimbs = selection.filters.onlyTallClimbs && !showTallClimbsFilter;
    const shouldClearWideClimbs = selection.filters.onlyWideClimbs && !showWideClimbsFilter;
    if (!shouldClearTallClimbs && !shouldClearWideClimbs) return;
    onChange(
      updateFilters(selection, {
        ...(shouldClearTallClimbs ? { onlyTallClimbs: false } : {}),
        ...(shouldClearWideClimbs ? { onlyWideClimbs: false } : {}),
      }),
    );
  }, [selection, showTallClimbsFilter, showWideClimbsFilter, onChange]);

  // Adding the first block reveals the workout builder — the mobile analogue of
  // web's `Workout Generator Opened`. Match web's exact payload
  // (playlist-generator-drawer.tsx): `{ targetType, boardName, angle }`. The
  // pre-session flow always feeds the session queue, so targetType is 'session';
  // PostHog groups by exact prop name, so the keys must line up.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const handleBlocksChange = useCallback(
    (next: GeneratorSelection) => {
      if (!hasWorkoutBlocks(selectionRef.current) && hasWorkoutBlocks(next)) {
        track(SHARED_EVENTS.WorkoutGeneratorOpened, { targetType: 'session', boardName, angle });
      }
      onChange(next);
    },
    [angle, boardName, onChange],
  );

  const minAscentsOptions = useMemo(() => {
    const baseOptions = getMinAscentsFilterOptions();
    if (baseOptions.includes(filters.minAscents)) return baseOptions;
    return [...baseOptions, filters.minAscents].sort((first, second) => first - second);
  }, [filters.minAscents]);

  const updateFilter = (patch: Partial<WorkoutFilters>) => onChange(updateFilters(selection, patch));

  // Filter summary, built like ClimbFilterSheet's refineSummary: min ascents ·
  // stars · climb bias. Stars render as filled glyphs (a symbol, not
  // translatable copy); "Any" rating shows nothing so the line stays short.
  const filtersSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      t('mobile.session.preGeneratorMinAscentsOption', { value: formatMinAscentsFilterCount(filters.minAscents) }),
    );
    const ratingValue = getMinRatingPickerValue(filters.minRating);
    if (ratingValue != null && ratingValue > 0) parts.push('★'.repeat(ratingValue));
    parts.push(climbBiasLabel(filters.climbBias, t));
    return parts.join(' · ');
  }, [filters, t]);

  const climbBiasOptions = useMemo(
    () => CLIMB_BIAS_OPTIONS.map((climbBias) => ({ key: climbBias, label: climbBiasLabel(climbBias, t) })),
    [t],
  );
  const minRatingPickerValue = getMinRatingPickerValue(filters.minRating);

  return (
    <View>
      <SectionHeader title={t('mobile.session.preGeneratorLabel')} />
      <View style={styles.inset}>
        <WorkoutBlockList
          boardName={boardName}
          selection={selection}
          onChange={handleBlocksChange}
          onRevealBlock={onRevealBlock}
        />
      </View>

      {hasWorkoutBlocks(selection) ? (
        <View style={[styles.inset, styles.filtersInset]}>
          <CollapsibleSection title={t('mobile.session.preGeneratorClimbFilters')} summary={filtersSummary}>
            <View style={styles.filtersBody}>
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
                        onPress={() => updateFilter({ minAscents })}
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
                    onPress={() => updateFilter({ minRating: 0 })}
                    accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                      group: t('mobile.session.preGeneratorMinRating'),
                      value: t('mobile.session.preGeneratorAny'),
                    })}
                  />
                  <StarRating
                    value={minRatingPickerValue ?? undefined}
                    onChange={(rating) => updateFilter({ minRating: rating ?? 0 })}
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
                  onSelect={(climbBias) => updateFilter({ climbBias })}
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
                      onValueChange={(onlyTallClimbs) => updateFilter({ onlyTallClimbs })}
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
                      onValueChange={(onlyWideClimbs) => updateFilter({ onlyWideClimbs })}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          </CollapsibleSection>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // SectionHeader brings its own 16px inset; matching horizontal padding lines
  // the cards up with the screen's other cards and section headers.
  inset: {
    paddingHorizontal: spacing[4],
  },
  filtersInset: {
    marginTop: spacing[3],
  },
  filtersBody: {
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
