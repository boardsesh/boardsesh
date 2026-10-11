import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState, type LogbookSortPreset } from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { FilterButton, FILTER_FAB_SIZE } from '../search/FilterButton';
import { PressableSurface } from '../PressableSurface';
import { GlassSurface } from '../GlassSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { buildLogbookFacets, type LogbookFacetKey } from './LogbookChipRow.logic';

type LogbookCompactToolbarProps = {
  search: ReactNode;
  fontScale: number;
  availableWidth: number;
  sortPreset: LogbookSortPreset | null;
  onSelectPreset: (preset: LogbookSortPreset) => void;
  onOpenFilters: () => void;
  filters: LogbookFilterState;
  grades: Grade[];
  activeFilterCount: number;
  onUpdateFilters: (patch: Partial<LogbookFilterState>) => void;
};

export const LogbookCompactToolbar = memo(function LogbookCompactToolbar({
  search,
  fontScale,
  availableWidth,
  sortPreset,
  onSelectPreset,
  onOpenFilters,
  filters,
  grades,
  activeFilterCount,
  onUpdateFilters,
}: LogbookCompactToolbarProps) {
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const sortLabel =
    sortPreset === 'recent'
      ? t('mobile.logbook.preset.latest')
      : sortPreset === 'hardest'
        ? t('mobile.logbook.preset.hardest')
        : t('mobile.logbook.customSort');
  const actions = useMemo<AppMenuAction[]>(
    () => [
      { label: t('mobile.logbook.preset.latest'), selected: sortPreset === 'recent' },
      { label: t('mobile.logbook.preset.hardest'), selected: sortPreset === 'hardest' },
    ],
    [sortPreset, t],
  );
  const selectSort = useCallback(
    (index: number) => {
      if (index === 0) onSelectPreset('recent');
      else if (index === 1) onSelectPreset('hardest');
    },
    [onSelectPreset],
  );
  const activeFacets = useMemo(
    () => buildLogbookFacets(filters, grades, formatGrade, t).filter((facet) => facet.active),
    [filters, grades, formatGrade, t],
  );
  const clearFacet = useCallback(
    (key: LogbookFacetKey) => {
      switch (key) {
        case 'grade':
          onUpdateFilters({ minGrade: '', maxGrade: '' });
          break;
        case 'angle':
          onUpdateFilters({ angleRange: DEFAULT_LOGBOOK_FILTERS.angleRange });
          break;
        case 'date':
          onUpdateFilters({ fromDate: '', toDate: '' });
          break;
        case 'show':
          onUpdateFilters({ includeSends: true, includeAttempts: true, flashOnly: false, benchmarkOnly: false });
          break;
      }
    },
    [onUpdateFilters],
  );
  const showLabel = [
    !filters.includeAttempts
      ? t('mobile.logbook.status.sends')
      : !filters.includeSends
        ? t('mobile.logbook.status.attempts')
        : null,
    filters.flashOnly ? t('mobile.logbook.flashOnly') : null,
    filters.benchmarkOnly ? t('mobile.logbook.benchmarksOnly') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <View testID="logbook-compact-toolbar" style={[styles.row, fontScale > 1.3 && styles.stacked]}>
        <View style={[styles.search, fontScale > 1.3 && styles.fullWidth]}>{search}</View>
        <View style={styles.actions}>
          <AppMenu
            label={sortLabel}
            accessibilityLabel={`${t('mobile.logbook.sort')}: ${sortLabel}`}
            actions={actions}
            onSelectIndex={selectSort}
            wrapLabel
            maxWidth={Math.max(44, availableWidth - FILTER_FAB_SIZE - spacing[2])}
            style={styles.sort}
          />
          <FilterButton activeFilterCount={activeFilterCount} onPress={onOpenFilters} />
        </View>
      </View>
      {activeFacets.length > 0 ? (
        <View testID="logbook-active-filters" style={styles.summaries}>
          {activeFacets.map((facet) => {
            const label = facet.key === 'show' ? showLabel : facet.label;
            return (
              <GlassSurface key={facet.key} borderRadius={borderRadius.full} style={styles.summarySurface}>
                <PressableSurface
                  accessibilityRole="button"
                  accessibilityLabel={`${tCommon('actions.clear')}: ${label}`}
                  onPress={() => clearFacet(facet.key)}
                  style={styles.summary}
                >
                  <Text variant="footnote" style={styles.summaryLabel}>
                    {label}
                  </Text>
                  <Icon name="close" size={16} color={systemColors.secondaryLabel} />
                </PressableSurface>
              </GlassSurface>
            );
          })}
        </View>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], paddingBottom: spacing[2] },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  search: { flexDirection: 'row', flexGrow: 1, flexShrink: 0, flexBasis: 160, minWidth: 160 },
  fullWidth: { width: '100%', flexBasis: 'auto' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], maxWidth: '100%' },
  sort: { minHeight: 44 },
  summaries: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], paddingBottom: spacing[2] },
  summarySurface: { maxWidth: '100%' },
  summary: {
    minHeight: 44,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  summaryLabel: { flexShrink: 1 },
});
