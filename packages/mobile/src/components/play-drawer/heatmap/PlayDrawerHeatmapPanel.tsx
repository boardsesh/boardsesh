import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { SegmentedControl } from '../../SegmentedControl';
import { formatHeatmapClimbCount, HeatmapLegend } from '../../board/HeatmapLegend';
import { HeatmapDownloadLine } from '../../board/HeatmapDownloadLine';
import { HEATMAP_MODES, type HeatmapMode } from '../../board/heatmap-buckets';
import { useTheme } from '../../../providers/theme-provider';
import { useGrades } from '../../../lib/graphql/hooks';
import { countFilteredHolds, hasActiveClimbFilters } from '@boardsesh/climb-filters';
import { getFilterSummary } from '../../../lib/filter-summary';
import { DEFAULT_FILTERS } from '../../../lib/climb-filter-types';
import { useHeatmapFirstRunCaption } from '../../../lib/heatmap-first-run';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { PlayDrawerHeatmap } from './use-play-drawer-heatmap';

type PlayDrawerHeatmapPanelProps = {
  heatmap: PlayDrawerHeatmap;
  /** For the filter summary's grade names. */
  boardName: string;
  /**
   * The climber's active board when it is the board the drawer is drawing, else
   * null: the download offer only makes sense for the board they are standing at.
   */
  nudgeBoard: UserBoard | null;
};

/**
 * The block under the board while the heatmap is on: what the colours mean and
 * how many climbs they count, the colour mode, which climbs they count (the
 * list's filters, or the whole board) — or, for a board that is not on this
 * phone, one line offering the download.
 */
export const PlayDrawerHeatmapPanel = memo(function PlayDrawerHeatmapPanel({
  heatmap,
  boardName,
  nudgeBoard,
}: PlayDrawerHeatmapPanelProps) {
  if (!heatmap.enabled) return null;
  if (heatmap.source === 'download') {
    return heatmap.isResolving ? null : (
      <View style={styles.panel}>
        <HeatmapDownloadLine board={nudgeBoard} source="play_drawer" testID="hold-heatmap-download-line" />
      </View>
    );
  }
  return <HeatmapPanelBody heatmap={heatmap} boardName={boardName} />;
});

function HeatmapPanelBody({ heatmap, boardName }: { heatmap: PlayDrawerHeatmap; boardName: string }) {
  const { t, i18n } = useTranslation('climbs');
  const { systemColors, colorScheme } = useTheme();
  const { search, wholeBoard, toggleWholeBoard, mode, setMode, legend, climbCount } = heatmap;
  const showCaption = useHeatmapFirstRunCaption(heatmap.enabled);

  const modeOptions = useMemo(
    () =>
      HEATMAP_MODES.map((key) => ({
        key,
        label:
          key === 'climbs'
            ? t('mobile.heatmap.modes.climbs')
            : key === 'startsFinishes'
              ? t('mobile.heatmap.modes.startsFinishes')
              : t('mobile.heatmap.modes.grade'),
      })),
    [t],
  );
  const handleSelectMode = useCallback((next: HeatmapMode) => setMode(next), [setMode]);

  const isGrade = mode === 'grade';
  const lowLabel = isGrade ? t('mobile.heatmap.legend.easier') : t('mobile.heatmap.legend.fewClimbs');
  const highLabel = isGrade ? t('mobile.heatmap.legend.harder') : t('mobile.heatmap.legend.manyClimbs');
  const scopeLabel = climbCount === null ? null : formatHeatmapClimbCount(t, climbCount, i18n?.language);
  const caption = !showCaption
    ? null
    : isGrade
      ? t('mobile.heatmap.firstRun.grade')
      : mode === 'startsFinishes'
        ? colorScheme === 'dark'
          ? t('mobile.heatmap.firstRun.startsFinishesDark')
          : t('mobile.heatmap.firstRun.startsFinishesLight')
        : colorScheme === 'dark'
          ? t('mobile.heatmap.firstRun.climbsDark')
          : t('mobile.heatmap.firstRun.climbsLight');

  const status = heatmap.filterUnsupported
    ? t('mobile.heatmap.filterUnsupported')
    : heatmap.isError
      ? t('mobile.heatmap.loadFailed')
      : heatmap.isUnavailable
        ? t('mobile.heatmap.unavailable')
        : heatmap.isEmpty
          ? t('mobile.heatmap.empty')
          : null;

  return (
    <View style={styles.panel} testID="play-drawer-heatmap-legend">
      <HeatmapLegend
        legend={legend}
        lowLabel={lowLabel}
        highLabel={highLabel}
        allEqualLabel={t('mobile.heatmap.legend.allEqual')}
        scopeLabel={scopeLabel}
        showEdgeValues
      />
      {caption ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} testID="play-drawer-heatmap-caption">
          {caption}
        </Text>
      ) : null}
      <SegmentedControl
        options={modeOptions}
        selectedKey={mode}
        onSelect={handleSelectMode}
        accessibilityLabel={t('mobile.heatmap.modeLabel')}
      />
      {search ? (
        <HeatmapScopeChip
          search={search}
          boardName={boardName}
          wholeBoard={wholeBoard}
          holdPicksSkipped={heatmap.holdPicksSkipped}
          onPress={toggleWholeBoard}
        />
      ) : null}
      {status ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {status}
        </Text>
      ) : null}
    </View>
  );
}

function HeatmapScopeChip({
  search,
  boardName,
  wholeBoard,
  holdPicksSkipped,
  onPress,
}: {
  search: NonNullable<PlayDrawerHeatmap['search']>;
  boardName: string;
  wholeBoard: boolean;
  holdPicksSkipped: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  // The summary's grade names need the board's grade table (cached per board).
  const { data: grades } = useGrades(boardName);
  const summary = useMemo(() => {
    // The list's own summary covers the filter sheet and the name; the board
    // filters (benchmarks, holds, region) are named the way the list's tokens
    // name them, so a holds-only search still says what it is filtering on.
    const boardParts: string[] = [];
    if (search.boardFilters.onlyBenchmarks) boardParts.push(t('mobile.filter.benchmark'));
    const holdCount = countFilteredHolds(search.boardFilters.holdsFilter);
    if (holdCount > 0) boardParts.push(t('mobile.holdFilter.summaryCount', { count: holdCount }));
    if (search.boardFilters.zoneBox != null) boardParts.push(t('mobile.zoneFilter.title'));
    const listFiltered =
      hasActiveClimbFilters({
        ...search.filters,
        sortBy: DEFAULT_FILTERS.sortBy,
        sortOrder: DEFAULT_FILTERS.sortOrder,
      }) || search.searchText.trim().length > 0;
    const parts = listFiltered
      ? [getFilterSummary(search.filters, search.searchText, grades, t), ...boardParts]
      : boardParts;
    return parts.join(' · ');
  }, [search, grades, t]);
  const label = wholeBoard
    ? t('mobile.heatmap.wholeBoard')
    : holdPicksSkipped
      ? t('mobile.heatmap.holdPicksSkipped', { summary })
      : summary;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !wholeBoard }}
      accessibilityHint={wholeBoard ? t('mobile.heatmap.useFiltersHint') : t('mobile.heatmap.wholeBoardHint')}
      hitSlop={8}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: wholeBoard ? systemColors.separator : brandColors.primary },
        pressed && styles.pressed,
      ]}
    >
      <Icon name="filter" size={14} color={wholeBoard ? systemColors.secondaryLabel : brandColors.primary} />
      <Text
        variant="caption1"
        numberOfLines={1}
        style={styles.chipText}
        color={wholeBoard ? systemColors.secondaryLabel : brandColors.primary}
      >
        {label}
      </Text>
      <Icon name="chevron.down" size={12} color={wholeBoard ? systemColors.secondaryLabel : brandColors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[1],
    maxWidth: '100%',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.6,
  },
});
