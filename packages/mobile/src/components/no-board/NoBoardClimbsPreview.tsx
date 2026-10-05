// A read-only list of real climbs for a climber who has not picked a board.
//
// It is handed the setups to show and asks nobody who is looking: no auth, no
// active board, no navigation of its own. That is deliberate. Guest mode (#5654)
// needs the same "browse a setup with no bound board" surface, and it can mount
// this as is. The owner decides what a tap does; here it opens the board picker.
//
// One page, no filters, no swipe actions, no paging. It is a taste of the list,
// and "Find my board" stays pinned above it the whole time.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, InteractionManager, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { parseSetIds } from '@boardsesh/board-config';
import { DEFAULT_CLIMB_FILTER_STATE, toClimbSearchInput } from '@boardsesh/climb-filters';
import { Text } from '../Text';
import { Button } from '../Button';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { climbListRowStyles } from '../climb-list-row-styles';
import { BoardConfigChips, type ChipOption } from '../board-discovery/BoardConfigChips';
import { boardTypeLabel } from '../board-discovery/board-builder-labels';
import { useInfiniteSearchClimbs } from '../../lib/graphql/hooks/use-infinite-search-climbs';
import { ensureBackgroundsCached } from '../../lib/background-image-cache';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { NoBoardPreviewConfig } from '../../lib/boards/no-board-preview';

/** How many climbs the preview lists. One page, never a second. */
export const NO_BOARD_PREVIEW_PAGE_SIZE = 30;

// The popular order barely moves within a session, and a chip the climber has
// already looked at should come back without a spinner.
const PREVIEW_STALE_TIME_MS = 60 * 60 * 1000;

const PREVIEW_PAGINATION = { page: 0, pageSize: NO_BOARD_PREVIEW_PAGE_SIZE };

const EMPTY_CLIMBS: Climb[] = [];

/** How a setup's search ended, reported once per setup shown. */
export type NoBoardPreviewSearchOutcome = 'ready' | 'error' | 'empty';

type NoBoardClimbsPreviewProps = {
  /** The setups to offer, first one shown first. Must hold at least one. */
  configs: readonly NoBoardPreviewConfig[];
  onFindBoard: () => void;
  /** A climb was tapped. `rowIndex` is its 0-based place in the list. */
  onClimbPress: (config: NoBoardPreviewConfig, rowIndex: number) => void;
  /** The shown setup's search finished. The owner falls back on anything but `ready`. */
  onSearchSettled: (outcome: NoBoardPreviewSearchOutcome, config: NoBoardPreviewConfig) => void;
};

type PreviewRowProps = {
  climb: Climb;
  rowIndex: number;
  config: NoBoardPreviewConfig;
  accessibilityHint: string;
  onPress: (rowIndex: number) => void;
};

const PreviewRow = memo(function PreviewRow({ climb, rowIndex, config, accessibilityHint, onPress }: PreviewRowProps) {
  const { systemColors } = useTheme();
  const handlePress = useCallback(() => onPress(rowIndex), [onPress, rowIndex]);
  return (
    <Pressable
      testID={`no-board-preview-row-${rowIndex}`}
      onPress={handlePress}
      accessibilityRole="button"
      // No label of its own: React Native composes the name, grade and stats
      // from the row content, as the real list's rows do.
      accessibilityHint={accessibilityHint}
      style={{ backgroundColor: systemColors.background }}
    >
      <View style={climbListRowStyles.contentRow}>
        <ClimbListItemContent
          climb={climb}
          boardName={config.boardName}
          layoutId={config.layoutId}
          sizeId={config.sizeId}
          setIds={config.setIds}
          angle={config.angle}
          // The glyph is the climber's own sends on their own board. There is
          // no board here, so the slot stays empty rather than reserved.
          showAscentStatus={false}
        />
      </View>
      <View style={[climbListRowStyles.separator, { backgroundColor: systemColors.separator }]} />
    </Pressable>
  );
});

function previewRowKey(climb: Climb): string {
  return climb.uuid;
}

function NoBoardClimbsPreviewComponent({
  configs,
  onFindBoard,
  onClimbPress,
  onSearchSettled,
}: NoBoardClimbsPreviewProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const colorScheme = useAppColorScheme();
  const insets = useSafeAreaInsets();
  const { scrollBottomPadding } = useBottomChromeMetrics();

  const [selectedIndex, setSelectedIndex] = useState(0);
  // The list can only shrink if the owner swaps it, which it does not do
  // mid-view; the clamp keeps a stale index from reading past the end anyway.
  const config = configs[Math.min(selectedIndex, configs.length - 1)];

  const searchInput = useMemo(
    () => toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, config, PREVIEW_PAGINATION),
    [config],
  );
  // `fetchNextPage` is never called: one page is the whole preview.
  const { data: searchPages, isError } = useInfiniteSearchClimbs(searchInput, true, {
    staleTime: PREVIEW_STALE_TIME_MS,
  });
  const firstPage = searchPages?.pages[0];
  const climbs = firstPage?.climbs ?? EMPTY_CLIMBS;

  const searchOutcome: NoBoardPreviewSearchOutcome | null = firstPage
    ? climbs.length > 0
      ? 'ready'
      : 'empty'
    : isError
      ? 'error'
      : null;
  useEffect(() => {
    if (searchOutcome !== null) onSearchSettled(searchOutcome, config);
  }, [searchOutcome, config, onSearchSettled]);

  // Thumbnails draw over the board art for this setup. On a real board the
  // Climbs screen warms it; nothing has for a setup nobody bound.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      void ensureBackgroundsCached({
        boardName: config.boardName,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: parseSetIds(config.setIds),
        colorScheme,
      });
    });
    return () => {
      task.cancel();
    };
  }, [config, colorScheme]);

  const boardTypeOptions = useMemo<ChipOption<number>[]>(
    () =>
      configs.map((previewConfig, configIndex) => ({
        key: previewConfig.boardName,
        label: boardTypeLabel(previewConfig.boardName),
        value: configIndex,
        selected: previewConfig === config,
      })),
    [configs, config],
  );

  const handleRowPress = useCallback((rowIndex: number) => onClimbPress(config, rowIndex), [onClimbPress, config]);
  const rowHint = t('mobile.emptyState.noBoardPreview.rowHint');
  const renderRow = useCallback(
    ({ item: climb, index: rowIndex }: { item: Climb; index: number }) => (
      <PreviewRow
        climb={climb}
        rowIndex={rowIndex}
        config={config}
        accessibilityHint={rowHint}
        onPress={handleRowPress}
      />
    ),
    [config, rowHint, handleRowPress],
  );

  const listContentStyle = useMemo(() => ({ paddingBottom: scrollBottomPadding }), [scrollBottomPadding]);
  const hasClimbs = climbs.length > 0;

  return (
    <View
      testID="no-board-climbs-preview"
      style={[styles.container, { paddingTop: insets.top, backgroundColor: systemColors.background }]}
    >
      <View style={[styles.header, { borderBottomColor: systemColors.separator }]}>
        <Text variant="title3" accessibilityRole="header">
          {t('mobile.emptyState.noBoardPreview.title')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.emptyState.noBoardPreview.subtitle', {
            board: boardTypeLabel(config.boardName),
            angle: config.angle,
          })}
        </Text>
        <Button
          testID="no-board-preview-find-board"
          title={t('mobile.emptyState.noBoard.cta')}
          onPress={onFindBoard}
          variant="filled"
          size="large"
          style={styles.cta}
        />
        {configs.length > 1 ? (
          <BoardConfigChips
            groupLabel={t('mobile.emptyState.noBoardPreview.boardTypeGroup')}
            options={boardTypeOptions}
            onSelect={setSelectedIndex}
          />
        ) : null}
      </View>
      {hasClimbs ? (
        <FlashList
          testID="no-board-preview-list"
          data={climbs}
          renderItem={renderRow}
          keyExtractor={previewRowKey}
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={listContentStyle}
          ListFooterComponent={
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
              {t('mobile.emptyState.noBoardPreview.footer')}
            </Text>
          }
        />
      ) : (
        // Loading, and the moment between a failed or empty search and the
        // owner swapping this for the placard.
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

/**
 * Memoized: the owner re-renders when its queries refetch, and none of that
 * should reach thirty board thumbnails. Every prop is stable across those.
 */
export const NoBoardClimbsPreview = memo(NoBoardClimbsPreviewComponent);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    gap: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    marginTop: spacing[1],
  },
  footer: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[5],
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
