// A read-only preview of real climbs for a climber who has not picked a board.
//
// It is handed the setups to show and asks nobody who is looking: no auth, no
// active board, no navigation of its own. That is deliberate. Guest mode (#5654)
// needs the same "browse a setup with no bound board" surface, and it can mount
// this as is. The owner decides what a tap does; here it opens the board picker.
//
// The top of it is the wall itself: the most sent climb on the setup, lit on a
// board drawn as large as the first screen allows (`NoBoardHero`). The rest of
// the page follows as ordinary rows. All of that is one list and scrolls away;
// only "Find my board" stays put, docked above the tab bar.
//
// One page, no filters, no swipe actions, no paging. The one thing the climber
// can do to the list is type a climb's name in the Climbs search field.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { InteractionManager, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { parseSetIds } from '@boardsesh/board-config';
import { DEFAULT_CLIMB_FILTER_STATE, toClimbSearchInput } from '@boardsesh/climb-filters';
import { Text } from '../Text';
import { Button } from '../Button';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import { THUMBNAIL_WIDTH } from '../ClimbListThumbnail';
import { climbListRowStyles } from '../climb-list-row-styles';
import { BoardConfigChips, type ChipOption } from '../board-discovery/BoardConfigChips';
import { boardTypeLabel } from '../board-discovery/board-builder-labels';
import { NoBoardHero } from './NoBoardHero';
import { NO_BOARD_DOCK_GAP, NoBoardFindBoardDock } from './NoBoardFindBoardDock';
import { staleTimeUnlessEmpty, useInfiniteSearchClimbs } from '../../lib/graphql/hooks/use-infinite-search-climbs';
import { ensureBackgroundsCached } from '../../lib/background-image-cache';
import { getBoardRenderData } from '../../lib/board-details';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useConnectivityBannerHeight } from '../../lib/connectivity-banner-inset-store';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { NoBoardPreviewConfig } from '../../lib/boards/no-board-preview';
import {
  NO_BOARD_DOCK_BUTTON_HEIGHT,
  NO_BOARD_HERO_GUTTER,
  computeNoBoardHeroBox,
  noBoardStageColors,
  sceneBackgroundHex,
} from '../../lib/boards/no-board-hero-layout';

/** How many climbs the preview lists. One page, never a second. */
export const NO_BOARD_PREVIEW_PAGE_SIZE = 30;

// The popular order barely moves within a session, and a chip the climber has
// already looked at should come back lit at once. An empty page is the
// exception: it is also what a search answers with while there is no
// connection, so it is asked for again once there is one.
const PREVIEW_STALE_TIME_MS = 60 * 60 * 1000;
const PREVIEW_SEARCH_OPTIONS = { staleTime: staleTimeUnlessEmpty(PREVIEW_STALE_TIME_MS) };

const PREVIEW_PAGINATION = { page: 0, pageSize: NO_BOARD_PREVIEW_PAGE_SIZE };

const EMPTY_CLIMBS: Climb[] = [];

/** A name shorter than this is not searched: one letter matches half the board. */
const MIN_NAME_QUERY_LENGTH = 2;

const SKELETON_ROW_KEYS = ['first', 'second', 'third', 'fourth'] as const;

const STAGE_START = { x: 0.5, y: 0 } as const;
const STAGE_END = { x: 0.5, y: 1 } as const;
// A glow behind the board, not a tint from the top: it starts from the plain
// background under the status bar and is gone again before the caption's last
// line, so the first row sits on the plain background too.
const STAGE_LOCATIONS = [0, 0.4, 0.9] as const;

/** How a setup's search ended, reported once per setup shown. */
export type NoBoardPreviewSearchOutcome = 'ready' | 'error' | 'empty';

type NoBoardClimbsPreviewProps = {
  /** The setups to offer, first one shown first. Must hold at least one. */
  configs: readonly NoBoardPreviewConfig[];
  onFindBoard: () => void;
  /**
   * A row was tapped. `rowIndex` is the climb's 0-based place among the climbs
   * shown: the lit board is place 0, so the first row under it is 1.
   */
  onClimbPress: (config: NoBoardPreviewConfig, rowIndex: number) => void;
  /** The lit board, or its caption, was tapped. It shows the climb at place 0. */
  onHeroPress: (config: NoBoardPreviewConfig) => void;
  /**
   * The shown setup's search finished. Until one setup has come back `ready`
   * the owner is expected to take the preview away on anything else; after
   * that the list shows a failed or empty setup itself. A search by name never
   * reports: a name nobody used is not a setup with no climbs.
   */
  onSearchSettled: (outcome: NoBoardPreviewSearchOutcome) => void;
  /**
   * What the climber has typed in the Climbs search field. Two characters or
   * more list the setup's climbs with that name in place of the lit board,
   * once the preview has shown climbs at all.
   */
  searchName?: string;
  /**
   * False while the climber cannot see the preview (another screen is over
   * it). Nothing is searched and no board art is fetched until it is true.
   * Defaults to true.
   */
  active?: boolean;
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
      <View style={[climbListRowStyles.contentRow, styles.rowGutter]}>
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
      <View style={[climbListRowStyles.separator, styles.rowSeparator, { backgroundColor: systemColors.separator }]} />
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
  onHeroPress,
  onSearchSettled,
  searchName = '',
  active = true,
}: NoBoardClimbsPreviewProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors, variant } = useTheme();
  const colorScheme = useAppColorScheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { scrollBottomPadding, floatingControlBottom } = useBottomChromeMetrics();
  // The board is sized against the chrome as it is without the connectivity
  // banner. The banner comes and goes with the backend, and a board that
  // shrank and grew with it would jump under the climber's thumb.
  const connectivityBannerHeight = useConnectivityBannerHeight();
  const restingControlBottom = floatingControlBottom - connectivityBannerHeight;

  const [selectedIndex, setSelectedIndex] = useState(0);
  // The list can only shrink if the owner swaps it, which it does not do
  // mid-view; the clamp keeps a stale index from reading past the end anyway.
  const config = configs[Math.min(selectedIndex, configs.length - 1)];
  const hasChips = configs.length > 1;

  // Climbs have been on screen. Before that a failed or empty search is the
  // owner's cue to take the preview away, so only the unlit wall and skeleton
  // rows show. After it, the climber chose another board type from a working
  // list: that setup's failure is shown in place, with the chips still there
  // to go back.
  const [hasShownClimbs, setHasShownClimbs] = useState(false);

  // A name is only searched once the preview is up. Until then the screen may
  // still be handed back to the placard, and a name with no match must never
  // be what does that.
  const typedName = searchName.trim();
  const nameQuery = hasShownClimbs && typedName.length >= MIN_NAME_QUERY_LENGTH ? typedName : '';
  const searching = nameQuery.length > 0;

  const searchInput = useMemo(
    () =>
      toClimbSearchInput(
        DEFAULT_CLIMB_FILTER_STATE,
        config,
        PREVIEW_PAGINATION,
        nameQuery ? { name: nameQuery } : undefined,
      ),
    [config, nameQuery],
  );
  // `fetchNextPage` is never called: one page is the whole preview.
  const {
    data: searchPages,
    isError,
    failureCount,
    refetch,
  } = useInfiniteSearchClimbs(searchInput, active, PREVIEW_SEARCH_OPTIONS);
  const firstPage = searchPages?.pages[0];
  const climbs = firstPage?.climbs ?? EMPTY_CLIMBS;
  const hasClimbs = climbs.length > 0;

  // The first failed attempt already counts as an error. React Query would
  // retry twice more before saying so itself, and that is seconds of skeleton
  // on a backend that is not answering. The retries carry on behind whatever
  // is shown instead, and a late success fills the cache.
  const searchFailed = isError || failureCount > 0;
  const searchOutcome: NoBoardPreviewSearchOutcome | null = firstPage
    ? hasClimbs
      ? 'ready'
      : 'empty'
    : searchFailed
      ? 'error'
      : null;
  // The latch is set here, after the owner has been told, and not during
  // render: a name already in the field would otherwise turn this into a name
  // search before the effect ran, and the owner would never hear `ready`. Only
  // the setup's own list can set it, since `searching` is false until it has.
  useEffect(() => {
    if (searchOutcome === null || searching) return;
    onSearchSettled(searchOutcome);
    if (searchOutcome === 'ready') setHasShownClimbs(true);
    // `config` is a dependency on purpose: each setup shown reports once.
  }, [searchOutcome, searching, config, onSearchSettled]);
  const nameHasNoMatch = searching && searchOutcome === 'empty';
  const inlineProblem =
    hasShownClimbs && !nameHasNoMatch && (searchOutcome === 'error' || searchOutcome === 'empty')
      ? searchOutcome
      : null;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // The board and its thumbnails draw over the board art for this setup. On a
  // real board the Climbs screen warms it; nothing has for a setup nobody bound.
  useEffect(() => {
    if (!active) return undefined;
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
  }, [active, config, colorScheme]);

  // The big board. Without render data there is nothing to size it by, so the
  // preview is the plain list from the first climb. The popular list carries
  // no spray wall today; the token is what would bring the board back if a
  // setup ever named one whose data lands after this renders.
  const sprayToken = useSprayWallToken(config.boardName, config.layoutId);
  const boardRenderData = useMemo(
    () =>
      getBoardRenderData({
        boardName: config.boardName,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: parseSetIds(config.setIds),
      }),
    // `sprayToken` is a real dependency: it is what recomputes this when a
    // wall lands or is reset.
    [config, sprayToken],
  );
  const heroBox = useMemo(
    () =>
      boardRenderData && boardRenderData.boardHeight > 0
        ? computeNoBoardHeroBox({
            windowWidth,
            windowHeight,
            insetTop: insets.top,
            floatingControlBottom: restingControlBottom,
            hasChips,
            aspect: boardRenderData.boardWidth / boardRenderData.boardHeight,
          })
        : null,
    [boardRenderData, windowWidth, windowHeight, insets.top, restingControlBottom, hasChips],
  );
  const showHero = heroBox !== null && !searching;
  // `BoardImageNative` has no way to be told to wait, so the hero's board
  // mounts only once the climber has seen this screen. Set during render
  // (React's "adjust state while rendering" pattern) so the frame that becomes
  // active already draws it; an effect would show one frame without the board.
  // It cannot loop: the guard is false for good once the latch is set.
  const [hasBeenActive, setHasBeenActive] = useState(active);
  if (!hasBeenActive && active) setHasBeenActive(true);

  // Under a hero the list starts at the second climb; the first is on the wall.
  const rowIndexOffset = showHero ? 1 : 0;
  const listClimbs = useMemo(() => (showHero ? climbs.slice(1) : climbs), [showHero, climbs]);
  const heroClimb = showHero ? (climbs[0] ?? null) : null;

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

  const handleHeroPress = useCallback(() => onHeroPress(config), [onHeroPress, config]);
  const handleRowPress = useCallback((rowIndex: number) => onClimbPress(config, rowIndex), [onClimbPress, config]);
  const rowHint = t('mobile.emptyState.noBoardPreview.rowHint');
  const renderRow = useCallback(
    ({ item: climb, index: listIndex }: { item: Climb; index: number }) => (
      <PreviewRow
        climb={climb}
        rowIndex={listIndex + rowIndexOffset}
        config={config}
        accessibilityHint={rowHint}
        onPress={handleRowPress}
      />
    ),
    [config, rowHint, handleRowPress, rowIndexOffset],
  );

  // Gradients take concrete colours only; see `sceneBackgroundHex`.
  const stage = useMemo(
    () => noBoardStageColors(sceneBackgroundHex(variant, colorScheme, Platform.OS), brandColors.primary, colorScheme),
    [variant, colorScheme, brandColors.primary],
  );
  const stageColors = useMemo(() => [stage.background, stage.glow, stage.background] as const, [stage]);
  // Everything scrolls, so rows pass under the status bar. The cap is the page
  // background, solid behind the clock with a short fade under it: nothing to
  // see at the top of the list, and no band of its own once the rows are
  // under it.
  const statusCapHeight = insets.top + spacing[3];
  const statusCapColors = useMemo(() => [stage.background, stage.background, stage.backgroundClear] as const, [stage]);
  const statusCapLocations = useMemo(
    () => [0, statusCapHeight > 0 ? insets.top / statusCapHeight : 0, 1] as const,
    [insets.top, statusCapHeight],
  );
  const stageStyle = useMemo(() => [styles.stage, { top: insets.top }], [insets.top]);

  const heroHint = t('mobile.emptyState.noBoardPreview.heroHint');
  const boardTypeGroupLabel = t('mobile.emptyState.noBoardPreview.boardTypeGroup');
  const searchTitle = searching ? t('mobile.emptyState.noBoardPreview.searchTitle', { name: nameQuery }) : null;
  const noMatchText = nameHasNoMatch ? t('mobile.emptyState.noBoardPreview.searchEmpty', { name: nameQuery }) : null;
  const problemText =
    inlineProblem === 'error'
      ? t('mobile.emptyState.noBoardPreview.loadError')
      : inlineProblem === 'empty'
        ? t('mobile.emptyState.noClimbs.title')
        : null;
  const retryTitle = t('mobile.emptyState.noBoardPreview.retry');
  const headerTopPadding = insets.top + spacing[2];
  const separatorColor = systemColors.separator;
  const secondaryLabelColor = systemColors.secondaryLabel;
  const labelColor = systemColors.label;
  const heroLoading = !hasClimbs && inlineProblem === null;

  const listHeader = useMemo(
    () => (
      <View style={[styles.header, { paddingTop: headerTopPadding, borderBottomColor: separatorColor }]}>
        {showHero ? (
          <LinearGradient
            pointerEvents="none"
            colors={stageColors}
            locations={STAGE_LOCATIONS}
            start={STAGE_START}
            end={STAGE_END}
            style={stageStyle}
          />
        ) : null}
        {hasChips ? (
          <BoardConfigChips groupLabel={boardTypeGroupLabel} options={boardTypeOptions} onSelect={setSelectedIndex} />
        ) : null}
        {/* Above the board, not under it: the connectivity banner covers the
            bottom of the screen in exactly the moments this shows. */}
        {problemText ? (
          <View testID="no-board-preview-problem" style={styles.problem}>
            <Text variant="subheadline" color={labelColor} style={styles.problemText}>
              {problemText}
            </Text>
            <Button
              testID="no-board-preview-retry"
              title={retryTitle}
              onPress={handleRetry}
              variant="tonal"
              size="medium"
            />
          </View>
        ) : null}
        {showHero && heroBox && boardRenderData ? (
          <NoBoardHero
            config={config}
            climb={heroClimb}
            loading={heroLoading}
            mountBoard={hasBeenActive}
            box={heroBox}
            cardBorderColor={stage.cardBorder}
            boardWidth={boardRenderData.boardWidth}
            boardHeight={boardRenderData.boardHeight}
            onPress={handleHeroPress}
            accessibilityHint={heroHint}
          />
        ) : null}
        {searchTitle ? (
          <Text testID="no-board-preview-search-title" variant="headline" accessibilityRole="header">
            {searchTitle}
          </Text>
        ) : null}
        {noMatchText ? (
          <Text testID="no-board-preview-search-empty" variant="subheadline" color={secondaryLabelColor}>
            {noMatchText}
          </Text>
        ) : null}
      </View>
    ),
    [
      headerTopPadding,
      separatorColor,
      secondaryLabelColor,
      labelColor,
      stageColors,
      stageStyle,
      stage.cardBorder,
      hasChips,
      boardTypeGroupLabel,
      boardTypeOptions,
      showHero,
      heroBox,
      boardRenderData,
      config,
      heroClimb,
      heroLoading,
      hasBeenActive,
      handleHeroPress,
      heroHint,
      searchTitle,
      noMatchText,
      problemText,
      retryTitle,
      handleRetry,
    ],
  );

  // Rows are on their way: the first load, a chip nobody has opened yet, a
  // name still being looked up, and the moment between a first search that
  // failed or came back empty and the owner swapping this for the placard.
  const showSkeleton = !hasClimbs && inlineProblem === null && !nameHasNoMatch;
  const listEmpty = useMemo(
    () =>
      showSkeleton ? (
        <View testID="no-board-preview-skeleton" style={styles.skeletonGutter}>
          {SKELETON_ROW_KEYS.map((skeletonKey) => (
            <ClimbListRowSkeleton key={skeletonKey} />
          ))}
        </View>
      ) : null,
    [showSkeleton],
  );

  // The last row and the footer have to scroll clear of the docked button.
  const listContentStyle = useMemo(
    () => ({ paddingBottom: scrollBottomPadding + NO_BOARD_DOCK_BUTTON_HEIGHT + NO_BOARD_DOCK_GAP + spacing[6] }),
    [scrollBottomPadding],
  );
  // Only under the setup's own list: "the top 30" is not what a name search shows.
  const footerText =
    hasClimbs && !searching ? t('mobile.emptyState.noBoardPreview.footer', { shown: climbs.length }) : null;
  const listFooter = useMemo(
    () =>
      footerText ? (
        <Text variant="footnote" color={secondaryLabelColor} style={styles.footer}>
          {footerText}
        </Text>
      ) : null,
    [footerText, secondaryLabelColor],
  );

  return (
    <View testID="no-board-climbs-preview" style={[styles.container, { backgroundColor: systemColors.background }]}>
      <FlashList
        // One list per setup: a chip switch starts the new board at the top
        // instead of wherever the last list was scrolled to.
        key={config.boardName}
        testID="no-board-preview-list"
        data={listClimbs}
        renderItem={renderRow}
        keyExtractor={previewRowKey}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={listContentStyle}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
      />
      <LinearGradient
        pointerEvents="none"
        colors={statusCapColors}
        locations={statusCapLocations}
        start={STAGE_START}
        end={STAGE_END}
        style={[styles.statusCap, { height: statusCapHeight }]}
      />
      <NoBoardFindBoardDock
        title={t('mobile.emptyState.noBoard.cta')}
        onPress={onFindBoard}
        fadeFrom={stage.backgroundClear}
        fadeTo={stage.background}
      />
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
    paddingHorizontal: NO_BOARD_HERO_GUTTER,
    paddingBottom: spacing[4],
    gap: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stage: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Rows keep the page's 16-point gutter, so their thumbnails line up with the
  // board's card and their grades with the lit climb's.
  rowGutter: {
    paddingHorizontal: NO_BOARD_HERO_GUTTER,
  },
  rowSeparator: {
    marginLeft: THUMBNAIL_WIDTH + NO_BOARD_HERO_GUTTER + spacing[3],
  },
  // The skeleton row brings 8 points of its own.
  skeletonGutter: {
    paddingHorizontal: NO_BOARD_HERO_GUTTER - spacing[2],
  },
  statusCap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  footer: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[5],
  },
  problem: {
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[4],
  },
  problemText: {
    textAlign: 'center',
  },
});
