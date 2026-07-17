import { memo, useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Chip, Menu } from 'react-native-paper';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { readableTextColor } from '../grade/grade-chip-colors';
import { anyFilterActive, buildLogbookFacets } from './LogbookChipRow.logic';
import type { LogbookChipRowProps } from './LogbookChipRow.types';

type FacetChipProps = {
  active: boolean;
  label: string;
  onPress: () => void;
};

function FacetChip({ active, label, onPress }: FacetChipProps) {
  const { brandColors } = useTheme();
  const activeTheme = active
    ? {
        colors: {
          secondaryContainer: brandColors.accent,
          onSecondaryContainer: readableTextColor(brandColors.accent),
        },
      }
    : undefined;

  return (
    <Chip
      mode="outlined"
      selected={active}
      showSelectedCheck={false}
      onPress={onPress}
      accessibilityLabel={label}
      theme={activeTheme}
      style={styles.chip}
    >
      {label}
    </Chip>
  );
}

function LogbookChipRowComponent({
  sortPreset,
  onSelectPreset,
  onOpenFilters,
  filters,
  grades,
  onToggleFacet,
  onUpdateFilters,
}: LogbookChipRowProps) {
  const { t } = useTranslation('you');
  const { formatGrade } = useGradeFormat();
  const [showMenuVisible, setShowMenuVisible] = useState(false);
  const facets = useMemo(() => buildLogbookFacets(filters, grades, formatGrade, t), [filters, grades, formatGrade, t]);
  const grade = facets[0];
  const angle = facets[1];
  const show = facets[2];
  const date = facets[3];

  const handleToggleSends = useCallback(() => {
    const next = !filters.includeSends;
    if (!next && !filters.includeAttempts) return;
    onUpdateFilters({ includeSends: next, ...(next ? {} : { flashOnly: false }) });
  }, [filters.includeAttempts, filters.includeSends, onUpdateFilters]);
  const handleToggleAttempts = useCallback(() => {
    const next = !filters.includeAttempts;
    if (!next && !filters.includeSends) return;
    onUpdateFilters({ includeAttempts: next });
  }, [filters.includeAttempts, filters.includeSends, onUpdateFilters]);
  const flashOn = filters.flashOnly && filters.includeSends;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
    >
      <FacetChip active={anyFilterActive(facets)} label={t('mobile.logbook.filter')} onPress={onOpenFilters} />
      <FacetChip
        active={sortPreset === 'recent'}
        label={t('mobile.logbook.preset.latest')}
        onPress={() => onSelectPreset('recent')}
      />
      <FacetChip
        active={sortPreset === 'hardest'}
        label={t('mobile.logbook.preset.hardest')}
        onPress={() => onSelectPreset('hardest')}
      />
      <FacetChip active={grade.active} label={grade.label} onPress={() => onToggleFacet('grade')} />
      <FacetChip active={angle.active} label={angle.label} onPress={() => onToggleFacet('angle')} />
      <Menu
        visible={showMenuVisible}
        onDismiss={() => setShowMenuVisible(false)}
        anchor={<FacetChip active={show.active} label={show.label} onPress={() => setShowMenuVisible(true)} />}
      >
        <Menu.Item
          title={t('mobile.logbook.status.sends')}
          leadingIcon={filters.includeSends ? 'check' : undefined}
          onPress={handleToggleSends}
        />
        <Menu.Item
          title={t('mobile.logbook.status.attempts')}
          leadingIcon={filters.includeAttempts ? 'check' : undefined}
          onPress={handleToggleAttempts}
        />
        <Menu.Item
          title={t('mobile.logbook.flashOnly')}
          leadingIcon={flashOn ? 'check' : undefined}
          disabled={!filters.includeSends}
          onPress={() => onUpdateFilters({ flashOnly: !flashOn })}
        />
        <Menu.Item
          title={t('mobile.logbook.benchmarksOnly')}
          leadingIcon={filters.benchmarkOnly ? 'check' : undefined}
          onPress={() => onUpdateFilters({ benchmarkOnly: !filters.benchmarkOnly })}
        />
      </Menu>
      <FacetChip active={date.active} label={date.label} onPress={() => onToggleFacet('date')} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  chip: {
    marginRight: 0,
  },
});

export const LogbookChipRow = memo(LogbookChipRowComponent);
