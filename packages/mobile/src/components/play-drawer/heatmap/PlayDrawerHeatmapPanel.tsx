import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { SegmentedControl } from '../../SegmentedControl';
import { OfflineNudgeCard } from '../../offline/OfflineNudgeCard';
import { HEAT_RAMP, HEATMAP_MODES, type HeatmapMode } from '../../board/HeatmapOverlay';
import { useTheme } from '../../../providers/theme-provider';
import { useGrades } from '../../../lib/graphql/hooks';
import { getFilterSummary } from '../../../lib/filter-summary';
import { useOfflineNudge } from '../../../lib/offline-nudges/use-offline-nudge';
import { useConfirmBoardDownload } from '../../../offline/use-confirm-board-download';
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
 * The row under the board while the heatmap is on: what the colours mean, which
 * climbs they count (the list's filters, or the whole board), and — for a board
 * that is not on this phone — the offer to download it instead.
 */
export const PlayDrawerHeatmapPanel = memo(function PlayDrawerHeatmapPanel({
  heatmap,
  boardName,
  nudgeBoard,
}: PlayDrawerHeatmapPanelProps) {
  if (!heatmap.enabled) return null;
  if (heatmap.source === 'download') {
    return heatmap.isResolving ? null : <HeatmapDownloadOffer board={nudgeBoard} />;
  }
  return <HeatmapLegend heatmap={heatmap} boardName={boardName} />;
});

function HeatmapLegend({ heatmap, boardName }: { heatmap: PlayDrawerHeatmap; boardName: string }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { search, wholeBoard, toggleWholeBoard, mode, setMode } = heatmap;

  const modeOptions = useMemo(
    () =>
      HEATMAP_MODES.map((key) => ({
        key,
        label:
          key === 'uses'
            ? t('mobile.heatmap.modes.uses')
            : key === 'ascents'
              ? t('mobile.heatmap.modes.ascents')
              : t('mobile.heatmap.modes.difficulty'),
      })),
    [t],
  );
  const handleSelectMode = useCallback((next: HeatmapMode) => setMode(next), [setMode]);

  const status = heatmap.filterUnsupported
    ? t('mobile.heatmap.filterUnsupported')
    : heatmap.isError
      ? t('mobile.heatmap.loadFailed')
      : heatmap.isEmpty
        ? t('mobile.heatmap.empty')
        : null;

  return (
    <View style={styles.legend} testID="play-drawer-heatmap-legend">
      <SegmentedControl
        options={modeOptions}
        selectedKey={mode}
        onSelect={handleSelectMode}
        accessibilityLabel={t('mobile.heatmap.modeLabel')}
      />
      <View style={styles.legendRow}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {mode === 'difficulty' ? t('mobile.heatmap.legendEasy') : t('mobile.heatmap.legendLow')}
        </Text>
        <View style={styles.ramp} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {HEAT_RAMP.map((color) => (
            <View key={color} style={[styles.rampStep, { backgroundColor: color }]} />
          ))}
        </View>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {mode === 'difficulty' ? t('mobile.heatmap.legendHard') : t('mobile.heatmap.legendHigh')}
        </Text>
        <View style={styles.spacer} />
        {search ? (
          <HeatmapFilterChip search={search} boardName={boardName} wholeBoard={wholeBoard} onPress={toggleWholeBoard} />
        ) : null}
      </View>
      {status ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {status}
        </Text>
      ) : null}
    </View>
  );
}

function HeatmapFilterChip({
  search,
  boardName,
  wholeBoard,
  onPress,
}: {
  search: NonNullable<PlayDrawerHeatmap['search']>;
  boardName: string;
  wholeBoard: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  // The summary's grade names need the board's grade table (cached per board).
  const { data: grades } = useGrades(boardName);
  const summary = useMemo(() => getFilterSummary(search.filters, search.searchText, grades, t), [search, grades, t]);
  const label = wholeBoard ? t('mobile.heatmap.wholeBoard') : t('mobile.heatmap.filtered', { summary });

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
    </Pressable>
  );
}

function HeatmapDownloadOffer({ board }: { board: UserBoard | null }) {
  const { t } = useTranslation('boards');
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { confirmAndDownload } = useConfirmBoardDownload();
  const nudge = useOfflineNudge({ surface: 'hold_heatmap', board });

  // Accept only once the size dialog said yes, like every other nudge surface.
  const handleDownload = useCallback(() => {
    if (!board) return;
    void confirmAndDownload(board, { trigger: 'hold_heatmap', source: 'play_drawer' }).then((confirmed) => {
      if (confirmed) nudge.accept('download');
    });
  }, [board, nudge, confirmAndDownload]);
  const handleDismiss = useCallback(() => nudge.dismiss('once'), [nudge]);

  if (!board || !nudge.visible) {
    // Downloading already, dismissed, or a board the climber is not standing at:
    // still say why the board is not lighting up.
    return (
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.fallback}>
        {tClimbs('mobile.heatmap.needsDownload')}
      </Text>
    );
  }

  return (
    <OfflineNudgeCard
      testID="hold-heatmap-offline-nudge"
      title={t('mobile.offline.nudge.holdHeatmap.title')}
      body={t('mobile.offline.nudge.holdHeatmap.body', { name: board.name })}
      primaryLabel={t('mobile.offline.nudge.holdHeatmap.cta', { name: board.name })}
      onPrimary={handleDownload}
      dismissLabel={t('mobile.offline.nudge.notNow')}
      onDismiss={handleDismiss}
      style={styles.nudge}
    />
  );
}

const styles = StyleSheet.create({
  legend: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  ramp: {
    flexDirection: 'row',
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  rampStep: {
    width: 14,
    height: 8,
  },
  spacer: {
    flex: 1,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    flexShrink: 1,
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
  fallback: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  nudge: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
  },
});
