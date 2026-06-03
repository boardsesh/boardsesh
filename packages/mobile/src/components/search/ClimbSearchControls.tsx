// The shared control row used by both search layouts (bottom bar + sticky
// strip): the grade pill (primary), removable active-filter pills, the live
// result count, and the filters gear with an active-count badge. A multi-filter
// query is always visible and one-tap-dismissible without opening the sheet.

import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { isAnyGrade, type ClimbBoardFilterState, type GradeBound } from '@boardsesh/climb-filters';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import { formatGradePillLabel } from './grade-pill-label';
import { buildActiveFilterPills } from './active-filter-pills';

type ClimbSearchControlsProps = {
  bound: GradeBound;
  grades: readonly Grade[];
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  /** Result count for the active filter set; undefined while loading. */
  count: number | undefined;
  activeFilterCount: number;
  onOpenGrade: () => void;
  onOpenFilters: () => void;
  onPatchFilters: (patch: Partial<ClimbFilters>) => void;
  onPatchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
};

function tintFromHex(hexColor: string | undefined): string | undefined {
  if (hexColor && /^#[0-9a-fA-F]{6}$/.test(hexColor)) return `${hexColor}24`;
  return undefined;
}

export function ClimbSearchControls({
  bound,
  grades,
  filters,
  boardFilters,
  count,
  activeFilterCount,
  onOpenGrade,
  onOpenFilters,
  onPatchFilters,
  onPatchBoardFilters,
}: ClimbSearchControlsProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  const gradeLabel = useMemo(
    () => formatGradePillLabel(bound, grades, formatGrade, t),
    [bound, grades, formatGrade, t],
  );

  const accentHex = useMemo(() => {
    const id = bound.minGradeId ?? bound.maxGradeId;
    if (id == null) return undefined;
    const grade = grades.find((entry) => entry.difficultyId === id);
    return grade ? (getGradeColor(grade.name) ?? undefined) : undefined;
  }, [bound, grades]);

  const pills = useMemo(() => buildActiveFilterPills(filters, boardFilters, t), [filters, boardFilters, t]);

  const gradeActive = !isAnyGrade(bound);
  const pillBackground = gradeActive ? (tintFromHex(accentHex) ?? systemColors.fill) : systemColors.fill;
  const pillBorder = gradeActive ? (accentHex ?? brandColors.primary) : iosSystemColors.separator;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onOpenGrade}
        accessibilityRole="button"
        accessibilityLabel={`${t('mobile.search.grade')}, ${gradeLabel}`}
        style={[styles.gradePill, { backgroundColor: pillBackground as string, borderColor: pillBorder }]}
      >
        {gradeActive && accentHex ? <View style={[styles.gradeDot, { backgroundColor: accentHex }]} /> : null}
        <Text variant="subheadline" style={styles.gradeText} numberOfLines={1}>
          {gradeLabel}
        </Text>
        <Icon name="chevron.down" size={13} color={systemColors.secondaryLabel as string} />
      </Pressable>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.pillsScroll}
        contentContainerStyle={styles.pillsContent}
      >
        {pills.map((pill) => (
          <Pressable
            key={pill.key}
            onPress={() => {
              hapticSelection();
              if (pill.clearFilters) onPatchFilters(pill.clearFilters);
              if (pill.clearBoard) onPatchBoardFilters(pill.clearBoard);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.search.removeFilter', { name: pill.label })}
            style={[styles.filterPill, { backgroundColor: systemColors.fill as string }]}
          >
            <Text variant="caption1" numberOfLines={1} style={styles.filterPillText}>
              {pill.label}
            </Text>
            <Icon name="close" size={11} color={systemColors.secondaryLabel as string} />
          </Pressable>
        ))}
      </ScrollView>

      {count != null ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.count}>
          {t('mobile.search.climbsCount', { count })}
        </Text>
      ) : null}

      <Pressable
        onPress={onOpenFilters}
        accessibilityRole="button"
        accessibilityLabel={
          activeFilterCount > 0 ? `${t('mobile.search.filters')}, ${activeFilterCount}` : t('mobile.search.filters')
        }
        hitSlop={8}
        style={styles.gearButton}
      >
        <Icon
          name="filter"
          size={22}
          color={activeFilterCount > 0 ? brandColors.primary : (systemColors.secondaryLabel as string)}
        />
        {activeFilterCount > 0 ? (
          <View style={styles.badge}>
            <Text variant="caption2" color={iosSystemColors.white} style={styles.badgeText}>
              {activeFilterCount}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  gradePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: '40%',
  },
  gradeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gradeText: {
    fontWeight: '600',
    flexShrink: 1,
  },
  pillsScroll: {
    flex: 1,
  },
  pillsContent: {
    alignItems: 'center',
    gap: spacing[1],
    paddingRight: spacing[1],
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingLeft: spacing[2],
    paddingRight: spacing[1],
    paddingVertical: 4,
    borderRadius: 14,
  },
  filterPillText: {
    fontWeight: '500',
    maxWidth: 120,
  },
  count: {
    flexShrink: 0,
  },
  gearButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: brandColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '700',
    fontSize: 10,
    lineHeight: 14,
  },
});
