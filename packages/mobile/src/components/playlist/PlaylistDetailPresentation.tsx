import type { Climb, QueueAddPlacement } from '@boardsesh/queue';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshControl,
  StyleSheet,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Appbar } from 'react-native-paper';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ownHeaderRight } from '../../hooks/use-header-actions';
import { usePullRefresh } from '../../hooks/use-pull-refresh';
import { useTypographyStyles } from '../../hooks/use-typography-styles';
import type { ReadyBoardArtSnapshot } from '../../lib/board-render/ready-board-art';
import type { PlaylistBoardBanner, PlaylistRenderBoard } from '../../lib/playlists/use-playlist-render-board';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { ButtonSurfaceProvider } from '../Button.surface';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { ProgressiveBlur } from '../ProgressiveBlur';
import { ReadableColumn } from '../ReadableColumn';
import { Text } from '../Text';
import { normalizePlaylistColor, PLAYLIST_COLORS } from './playlist-colors';
import { createStyles } from './playlist-detail-styles';
import { buildHeroGradient } from './playlist-gradient';
import { resolvePlaylistEmojiIcon } from './playlist-icon';
import { PlaylistAddToQueueRow } from './PlaylistAddToQueueRow';
import { PlaylistFilterHeaderButton } from './PlaylistFilterHeaderButton';
import { PlaylistPlayHeaderButton } from './PlaylistPlayHeaderButton';

/** Bottom scrim that keeps white title/meta legible across the palette (amber
 *  and green included) without per-colour luminance branching. */
const HERO_SCRIM_COLORS = ['transparent', 'transparent', 'rgba(0, 0, 0, 0.28)'] as const;
const HERO_SCRIM_LOCATIONS = [0, 0.45, 1] as const;
const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 1 } as const;
/** Nav-bar height (below the status-bar inset) for the collapsed header — tall
 *  enough to contain the header buttons, so they sit inside the bar rather than
 *  poking out under it. */
const NAV_BAR_HEIGHT = glassSize.standard + spacing[1] * 2;

/** Optional richer empty state (Material branch only). When omitted, the
 *  Material branch falls back to the same generic icon + `emptyMessage` the
 *  glass branch uses, so non-liked playlists keep their existing copy. */
export type PlaylistDetailEmptyState = {
  /** Semantic icon name (e.g. `favorite` for the liked-climbs surface). */
  icon: IconName;
  /** Headline (already translated). */
  title: string;
  /** Supporting line under the headline (already translated). */
  supporting?: string;
};

/** Optional CTA button under the empty state, shown in both variants. */
export type PlaylistDetailEmptyAction = {
  /** Already-translated button label. */
  label: string;
  /** Leading icon on the button. */
  icon?: IconName;
  onPress: () => void;
};

export type PlaylistDetailHero = {
  name: string;
  climbCount: number;
  color?: string;
  icon?: string;
  /** Playlist description, shown under the hero row. */
  description?: string;
  /** Secondary line under the climb count (e.g. the smart-playlist creator). */
  subtitle?: string;
  /** Already-translated follower-count line (public playlists). */
  followerLabel?: string;
  /** Board for the optional frosted board backdrop behind the hero square. */
  boardType?: string;
  layoutId?: number | null;
  showBoardBackdrop?: boolean;
};

/** The ≡ filter button in the header: what it shows and what it opens. */
export type PlaylistDetailFilterAction = {
  activeCount: number;
  onPress: () => void;
};

export type PlaylistDetailViewProps = {
  hero: PlaylistDetailHero;
  climbs: Climb[];
  /** Preferred active board for climb rows. Compatible rows render against it;
   *  incompatible rows resolve their own board config and are dimmed. */
  renderBoard: PlaylistRenderBoard | null;
  /** Set when the playlist belongs to a board other than the active one (or
   *  there is no active board). A switch-board banner shows above the list and
   *  activate-all is disabled; row taps still open the drawer so it can explain
   *  incompatibility. */
  boardBanner?: PlaylistBoardBanner | null;
  /** True while the first page loads (hero still renders; list shows a spinner). */
  isLoading: boolean;
  /** True while a subsequent page loads (trailing spinner). */
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  /**
   * Select a climb using the current lighting preference. The header's Play
   * button selects the first row through the same callback.
   */
  onActivateClimb: (climb: Climb, readyBoardArt?: ReadyBoardArtSnapshot) => void;
  /** Already-resolved empty-list copy (callers translate with a static key). */
  emptyMessage: string;
  /** An unavailable climb source keeps the hero while explaining the gap. */
  unavailableContent?: ReactNode;
  /**
   * The empty state's icon in both looks, when the list is empty for a reason
   * other than having no climbs (filtered to nothing, a failed load). Defaults to
   * the playlist icon; Material's `emptyState.icon` still wins there.
   */
  emptyIcon?: IconName;
  /** Richer Material-branch empty state (e.g. the liked-climbs heart prompt).
   *  Glass branch ignores this and keeps `emptyMessage`. */
  emptyState?: PlaylistDetailEmptyState;
  /** Optional CTA under the empty state (e.g. "Add climbs" on an owner's empty
   *  playlist). Rendered in BOTH variants; omit for a message-only empty state. */
  emptyAction?: PlaylistDetailEmptyAction;
  /** Top-right controls (follow / pin / more), given the current collapse state
   *  so a control can swap to its compact icon form once the colour header bar
   *  takes over. On Liquid Glass they are the native header's trailing item, next
   *  to its own back button; on Material they sit in the in-body app bar. Absent
   *  here = a back-only bar. */
  actions?: (collapsed: boolean) => ReactNode;
  /** Pull to refresh (HIG Refresh content controls). Refetch everything the
   *  screen shows; the spinner stays until the returned promise settles. Omit to
   *  turn pull-to-refresh off. */
  onRefresh?: () => unknown;
  /** Owner edit mode: rows swap to the reorder/remove treatment, tap-to-activate
   *  is disabled, and pagination is paused (the host passes a frozen list). */
  editMode?: boolean;
  /** Move a climb to a new 0-based index in the (loaded) list. */
  onReorderClimb?: (climbUuid: string, newIndex: number) => void;
  /** Remove a climb from the playlist (the host confirms + mutates). */
  onRemoveClimb?: (climbUuid: string) => void;
  /** In edit mode, a cog next to the playlist name opens the edit-details sheet. */
  onEditDetails?: () => void;
  /** Extra content rendered inside `ListHeaderComponent`, below the hero and the
   *  board-mismatch banner. Stays inside the existing FlashList header so no
   *  second scroll container is introduced. */
  headerSlot?: ReactNode;
  /** Play next / Play last for the whole playlist: put every climb in it at the
   *  top or the bottom of Up next, without clearing anything or moving the
   *  current climb. Omit to hide the rows — the callers withhold it when there is
   *  no active board, so "no board picked" collapses into "no rows" instead of
   *  controls that can only report an empty fetch. */
  onQueueAll?: (placement: QueueAddPlacement) => void;
  /** Which of the two is in flight (spinner in that row's trailing slot), or null. */
  pendingQueueAll?: QueueAddPlacement | null;
  /** "Play 12 next": how many a filtered playlist would add. Omit for the plain labels. */
  addToQueueCount?: number;
  /**
   * The playlist's filter chrome (chip row, tokens, status line), placed right
   * under the hero and outside its measured view, so the collapse point stays
   * the hero's edge. Smart playlists leave it out.
   */
  filterBar?: ReactNode;
  /**
   * The header's ≡ filter button. Liquid Glass shows it once the filter bar has
   * scrolled under the header; Material keeps it in the app bar. Never in edit
   * mode. Omit, or pass null, for no button.
   */
  filterAction?: PlaylistDetailFilterAction | null;
  /**
   * Changes whenever new rows replace the list (a new sort or filter). A list
   * scrolled past the hero then jumps back to just above the rows, so the
   * climber lands on the top of the new order rather than mid-list.
   */
  scrollResetKey?: string | null;
};

// FlashList keeps the first visible row in place across data changes by
// default. Here a new sort or filter is new rows, not more of the same: anchoring
// a row that moved down the order scrolled the list away from the top, and
// scrolled the header's native buttons above the screen while it did.
const KEEP_SCROLL_OFFSET_ON_NEW_ROWS = { disabled: true } as const;
const noopRefresh = () => undefined;
// A null custom title lets native-stack fall back to `title`, duplicating the
// name drawn by the hero/collapsed header. Keep a real, empty centre view.
const renderNoHeaderTitle = () => <View collapsable={false} accessible={false} />;

/**
 * Shared hero + paginated climb list for the playlist-detail and
 * smart-playlist-detail screens. Renders the colour/emoji hero, then a FlashList
 * of `ClimbListRow`s rendered from `renderBoard`, paginating via
 * `fetchNextPage` as the list nears its end.
 *
 * `renderBoard` is the user's active board for the common case. Rows whose
 * climbs do not fit that board render against their own board config and are
 * dimmed; the play drawer owns the incompatibility message when opened.
 *
 * Two presentations: the Liquid Glass variant keeps the full-bleed gradient hero
 * with white text and floating FABs; the Material 3 variant swaps in a Paper
 * `Appbar.Header` over a tonal hero band. Both share the scroll math, FlashList,
 * list state, and row rendering — only the hero chrome + state visuals branch.
 */
export type PlaylistDetailPresentationProps = PlaylistDetailViewProps & {
  renderItem: import('@shopify/flash-list').FlashListProps<Climb>['renderItem'];
  onViewableItemsChanged?: import('@shopify/flash-list').FlashListProps<Climb>['onViewableItemsChanged'];
  isDragging: boolean;
  listPaddingBottom: number;
  onBack: () => void;
  setHeaderOptions: (options: Record<string, unknown>) => void;
  wrapList: (list: ReactNode) => ReactNode;
  loadingRows: ReactNode;
  boardBackdrop?: ReactNode;
};
export function PlaylistDetailPresentation({
  renderItem,
  onViewableItemsChanged,
  isDragging,
  listPaddingBottom,
  onBack,
  setHeaderOptions,
  wrapList,
  loadingRows,
  boardBackdrop,
  hero,
  climbs,
  boardBanner,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  onActivateClimb,
  emptyMessage,
  unavailableContent,
  emptyIcon = 'playlist',
  emptyState,
  emptyAction,
  actions,
  editMode = false,
  onEditDetails,
  headerSlot,
  onQueueAll,
  pendingQueueAll = null,
  addToQueueCount,
  onRefresh,
  filterBar,
  filterAction,
  scrollResetKey = null,
}: PlaylistDetailPresentationProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('playlists');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const heroEmojiIcon = resolvePlaylistEmojiIcon(hero.icon);

  // Scroll offset + measured hero-banner height drive the collapsed colour header
  // bar (the playlist colour + centered name) that fades in once the hero scrolls
  // off the top — the Apple Music album-header idiom. The Material branch reuses
  // the same math to fade its app-bar title in as the hero band scrolls away.
  const scrollY = useSharedValue(0);
  const heroBannerHeight = useSharedValue(0);
  const headerBarHeight = insets.top + NAV_BAR_HEIGHT;
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );
  const handleHeroLayout = useCallback(
    (event: LayoutChangeEvent) => {
      heroBannerHeight.value = event.nativeEvent.layout.height;
    },
    [heroBannerHeight],
  );
  // Where the filter bar ends in the list's content, 0 until it is laid out (or
  // when there is none). The header's ≡ button waits until the bar is out of view.
  const filterBarBottom = useSharedValue(0);
  const handleFilterBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      filterBarBottom.value = y + height;
    },
    [filterBarBottom],
  );
  const headerBarStyle = useAnimatedStyle(() => {
    const banner = heroBannerHeight.value;
    if (banner <= 0) return { opacity: 0 };
    // Fully opaque once the banner's bottom edge reaches the bar's bottom.
    const threshold = Math.max(1, banner - headerBarHeight);
    return { opacity: interpolate(scrollY.value, [threshold - 24, threshold], [0, 1], Extrapolation.CLAMP) };
  });

  // How far the list has scrolled, in steps: 0 the hero is in view; 1 the
  // colour header bar has taken over, so action FABs (e.g. follow) swap to their
  // compact icon form and Material fades its app-bar title in; 2 the filter bar
  // under the hero has gone under the header too, so the glass header shows ≡.
  const [scrollStage, setScrollStage] = useState<0 | 1 | 2>(0);
  useAnimatedReaction(
    (): 0 | 1 | 2 => {
      const banner = heroBannerHeight.value;
      if (banner <= 0 || scrollY.value < banner - headerBarHeight) return 0;
      const barBottom = filterBarBottom.value;
      return barBottom > 0 && scrollY.value >= barBottom - headerBarHeight ? 2 : 1;
    },
    (stage, previousStage) => {
      if (stage !== previousStage) runOnJS(setScrollStage)(stage);
    },
  );
  const collapsed = scrollStage >= 1;
  const filterBarScrolledAway = scrollStage === 2;

  // Liquid Glass shows the NATIVE header (HIG Navigation bars): its back button
  // keeps the long-press history menu and the edge-swipe a hand-built chevron
  // can't give. It is transparent over the full-bleed hero, draws no title of its
  // own (the hero, then the collapsed colour bar below, carry the name; `title`
  // still names this screen in the back menu), and hosts the actions as its
  // trailing item. On iOS 26 that item already sits in the bar's Liquid Glass
  // capsule, so the region is declared `glass` and the controls inside drop
  // their own glass instead of stacking it (HIG Materials).
  //
  // Material keeps its in-body app bar, so the native header stays hidden
  // ("header XOR in-body Appbar", theme/variants/README.md).
  // Play: plays the list from its first row (#6667), in the glass header and
  // Material's app bar alike. Hidden on an empty list, behind the switch-board
  // banner (row taps still open the drawer so it can explain the mismatch) and
  // in edit mode. It goes through the row-tap callback, so it follows a row
  // tap's rule: it lights while this phone drives the wall, and previews
  // otherwise.
  //
  // The rows and the callback are read through refs: both change identity as
  // pages land, and the glass header re-sets its native options whenever the
  // handler changes.
  const showPlayAll = climbs.length > 0 && !boardBanner && !editMode;
  const playAllClimbsRef = useRef(climbs);
  playAllClimbsRef.current = climbs;
  const onActivateClimbRef = useRef(onActivateClimb);
  onActivateClimbRef.current = onActivateClimb;
  // `showPlayAll` already hides the button behind the board banner.
  const handleActivateAll = useCallback(() => {
    const first = playAllClimbsRef.current[0];
    if (first) onActivateClimbRef.current(first);
  }, []);

  const headerTitle = hero.name;
  useLayoutEffect(() => {
    if (isMaterial) {
      setHeaderOptions({ headerShown: false, headerRight: undefined });
      return;
    }
    // The ≡ filter button joins the capsule once the filter bar under the hero
    // has scrolled away (the chips it stands in for are out of view); edit mode
    // has no filters to open.
    const filterButton =
      filterBarScrolledAway && filterAction && !editMode ? (
        <PlaylistFilterHeaderButton activeCount={filterAction.activeCount} onPress={filterAction.onPress} />
      ) : null;
    const actionButtons = actions?.(collapsed) ?? null;
    const playButton = showPlayAll ? <PlaylistPlayHeaderButton onPress={handleActivateAll} /> : null;
    setHeaderOptions({
      headerShown: true,
      headerLargeTitle: false,
      headerTransparent: true,
      headerBlurEffect: 'none',
      // iOS 26 dims the scroll view under a transparent bar. The hero runs up under
      // it, so that dim reads as a dark band; the collapsed blur bar below is our
      // own edge effect once the hero scrolls away.
      scrollEdgeEffects: { top: 'hidden' },
      title: headerTitle,
      headerTitle: renderNoHeaderTitle,
      // Keyed on the memoised `actions`, `filterAction` and `collapsed`, never on
      // a rendered node: a fresh element each render would re-set the options on
      // every render. No item at all while there is nothing to show (an empty
      // list, behind the board banner, or edit mode without owner actions): iOS
      // draws an empty glass capsule for an item that renders nothing. `ownHeaderRight` also clears any
      // native bar item.
      ...ownHeaderRight(
        filterButton || actionButtons || playButton
          ? () => (
              <ButtonSurfaceProvider surface="glass">
                {filterButton}
                {actionButtons}
                {playButton}
              </ButtonSurfaceProvider>
            )
          : undefined,
      ),
    });
  }, [
    setHeaderOptions,
    isMaterial,
    headerTitle,
    actions,
    collapsed,
    filterBarScrolledAway,
    filterAction,
    editMode,
    showPlayAll,
    handleActivateAll,
  ]);

  // A new sort or filter lands while the climber is scrolled down past the
  // filter bar: bring them back up to it (the hero just tucked under the bar), so
  // they start at the top of the new order. Higher up there is nothing to do,
  // and the list never scrolls down.
  const listRef = useRef<FlashListRef<Climb>>(null);
  const lastScrollResetKeyRef = useRef(scrollResetKey);
  useEffect(() => {
    if (lastScrollResetKeyRef.current === scrollResetKey) return;
    lastScrollResetKeyRef.current = scrollResetKey;
    const barBottom = filterBarBottom.value;
    const heroTucked = heroBannerHeight.value - headerBarHeight;
    if (barBottom <= 0 || heroTucked <= 0) return;
    if (scrollY.value > barBottom - headerBarHeight && heroTucked < scrollY.value) {
      listRef.current?.scrollToOffset({ offset: heroTucked, animated: false });
    }
  }, [scrollResetKey, filterBarBottom, heroBannerHeight, scrollY, headerBarHeight]);

  const pullRefresh = usePullRefresh(onRefresh ?? noopRefresh);
  const refreshControl = onRefresh ? (
    <RefreshControl
      refreshing={pullRefresh.refreshing}
      onRefresh={pullRefresh.onRefresh}
      tintColor={brandColors.primary}
      // Android draws the spinner over the content; start it below the app bar.
      progressViewOffset={headerBarHeight}
    />
  ) : undefined;

  const loadNextPage = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const handleEndReached = loadNextPage;

  // Cog shown beside the playlist name only in edit mode — opens the
  // edit-details sheet (name / colour / icon / visibility). Tinted to match the
  // hero text of the current variant (white on glass, label on Material).
  const renderEditDetailsCog = (color: ColorValue) =>
    editMode && onEditDetails ? (
      <PressableSurface
        onPress={onEditDetails}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('editClimbs.editDetailsAria')}
        style={styles.heroCog}
      >
        <Icon name="settings" size={22} color={color} />
      </PressableSurface>
    ) : null;

  const baseColor = normalizePlaylistColor(hero.color) ?? PLAYLIST_COLORS[0];
  const islandFillStyle = useMemo(
    () => ({
      experimental_backgroundImage: `linear-gradient(to bottom, ${baseColor} ${insets.top}px, transparent ${insets.top}px)`,
    }),
    [baseColor, insets.top],
  );

  // Shared list state visuals. The first-page load renders skeleton rows (a far
  // better "shape of what's coming" cue than a bare spinner). Empty + footer are
  // shared; the empty body is variant-aware below.
  const listEmptyComponent =
    unavailableContent != null ? (
      <>{unavailableContent}</>
    ) : isLoading ? (
      <View style={styles.skeletonList}>{loadingRows}</View>
    ) : isMaterial ? (
      <MaterialEmptyState
        icon={emptyState?.icon ?? emptyIcon}
        title={emptyState?.title ?? emptyMessage}
        supporting={emptyState?.supporting}
        action={emptyAction}
        titleColor={systemColors.label}
        supportingColor={systemColors.secondaryLabel}
      />
    ) : (
      <View style={styles.stateContainer}>
        <Icon name={emptyIcon} size={44} color={systemColors.tertiaryLabel} />
        <Text variant="subheadline" style={styles.emptyText}>
          {emptyMessage}
        </Text>
        {emptyAction ? (
          <Button
            title={emptyAction.label}
            onPress={emptyAction.onPress}
            size="medium"
            icon={emptyAction.icon}
            style={styles.emptyActionButton}
            ignoreContainerSafeArea
          />
        ) : null}
      </View>
    );

  const listFooterComponent = isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator size="small" />
    </View>
  ) : null;

  // The filter bar, measured so the header knows when it has scrolled away.
  const filterBarNode = filterBar ? <View onLayout={handleFilterBarLayout}>{filterBar}</View> : null;

  // Switch-board banner shown when the playlist's board differs from the active
  // one. Sits inside the list header so it scrolls with the hero in both variants.
  const bannerNode = boardBanner ? <BoardMismatchBanner banner={boardBanner} systemColors={systemColors} /> : null;

  // Additive bulk queueing, above the discussion row in both variants — a queue
  // action outranks a comment thread. Same four conditions the destructive
  // bulk control uses, plus "the host actually handed us a handler" (withheld
  // when there is no active board, since the board-scoped fetch would be empty).
  const addToQueueNode =
    onQueueAll && climbs.length > 0 && !boardBanner && !editMode ? (
      <PlaylistAddToQueueRow onQueue={onQueueAll} pendingPlacement={pendingQueueAll} count={addToQueueCount} />
    ) : null;

  // ── Material 3 branch ───────────────────────────────────────────────────────
  if (isMaterial) {
    const accent = brandColors.primary;
    return (
      <View style={[styles.container, { backgroundColor: systemColors.background }]}>
        <ReadableColumn style={styles.container}>
          {wrapList(
            <FlashList
              ref={listRef}
              data={climbs}
              maintainVisibleContentPosition={KEEP_SCROLL_OFFSET_ON_NEW_ROWS}
              renderItem={renderItem}
              onViewableItemsChanged={onViewableItemsChanged}
              keyExtractor={keyExtractor}
              extraData={editMode}
              scrollEnabled={!isDragging}
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.5}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              refreshControl={refreshControl}
              contentContainerStyle={{ paddingBottom: listPaddingBottom }}
              ListHeaderComponent={
                <>
                  <View onLayout={handleHeroLayout} style={styles.materialHero}>
                    <View
                      style={[
                        styles.materialHeroBand,
                        { paddingTop: headerBarHeight + spacing[4], backgroundColor: systemColors.secondaryBackground },
                      ]}
                    >
                      <View
                        style={[styles.materialHeroEmojiCircle, { backgroundColor: systemColors.tertiaryBackground }]}
                      >
                        {heroEmojiIcon ? (
                          <Text style={styles.materialHeroEmoji} allowFontScaling={false}>
                            {heroEmojiIcon}
                          </Text>
                        ) : (
                          <Icon name="tag" size={36} color={systemColors.secondaryLabel} />
                        )}
                      </View>
                      <View style={styles.materialHeroNameRow}>
                        <Text
                          variant="title2"
                          numberOfLines={2}
                          color={systemColors.label}
                          style={styles.materialHeroName}
                        >
                          {hero.name}
                        </Text>
                        {renderEditDetailsCog(systemColors.label)}
                      </View>
                      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.materialHeroMeta}>
                        {t('detail.climbCount', { count: hero.climbCount })}
                      </Text>
                      {hero.followerLabel ? (
                        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.materialHeroMeta}>
                          {hero.followerLabel}
                        </Text>
                      ) : null}
                    </View>
                    {hero.description || hero.subtitle ? (
                      <View style={styles.heroBelow}>
                        {hero.description ? (
                          <Text variant="footnote" numberOfLines={3} color={systemColors.secondaryLabel}>
                            {hero.description}
                          </Text>
                        ) : null}
                        {hero.subtitle ? (
                          <Text variant="footnote" numberOfLines={1} color={systemColors.secondaryLabel}>
                            {hero.subtitle}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  {filterBarNode}
                  {bannerNode}
                  {addToQueueNode}
                  {headerSlot}
                </>
              }
              ListFooterComponent={listFooterComponent}
              ListEmptyComponent={listEmptyComponent}
            />,
          )}
        </ReadableColumn>

        {/* Collapsing M3 top app bar — sits over the hero band; its title fades in
            as the band scrolls under it, then the band's name is hidden behind.
            The wrapper is the absolute layer: Paper sends `style` to the inner bar,
            not to its in-flow root View, which would land below the list. */}
        <View
          style={[
            styles.materialAppbarContainer,
            { paddingTop: insets.top, backgroundColor: systemColors.secondaryBackground },
          ]}
        >
          <Appbar.Header
            statusBarHeight={0}
            mode="small"
            style={{ height: NAV_BAR_HEIGHT, backgroundColor: systemColors.secondaryBackground }}
          >
            <Appbar.BackAction
              onPress={onBack}
              color={systemColors.label as string}
              rippleColor={withAlpha(accent, 0.16)}
              accessibilityLabel={tCommon('ariaLabels.back')}
            />
            <Animated.View style={[styles.materialAppbarTitle, headerBarStyle]}>
              <Appbar.Content title={hero.name} titleStyle={styles.materialAppbarTitleText} />
            </Animated.View>
            {/* The ≡ filter button, then the owner / follow / pin controls. The app bar
              is always present on Material, so we ask for the compact icon form
              (`actions(true)`) — `GlassIconButton` routes to a Paper `IconButton`
              here, fitting the bar. */}
            {filterAction && !editMode ? (
              <PlaylistFilterHeaderButton activeCount={filterAction.activeCount} onPress={filterAction.onPress} />
            ) : null}
            {actions?.(true)}
            {showPlayAll ? (
              <Appbar.Action
                icon="play"
                color={accent as string}
                rippleColor={withAlpha(accent, 0.16)}
                onPress={handleActivateAll}
                accessibilityLabel={t('detail.activateAll')}
              />
            ) : null}
          </Appbar.Header>
        </View>
      </View>
    );
  }

  // ── Liquid Glass branch ──────────────────────────────────────────────────────
  const gradient = buildHeroGradient(hero.color);
  const showBackdrop = !!(hero.showBoardBackdrop && hero.boardType);
  // With the board backdrop on, drop the gradient to a translucent wash so the
  // blurred board ghosts through; otherwise it's the opaque colour banner.
  const gradientColors = showBackdrop
    ? ([
        withAlpha(gradient.colors[0], 0.82),
        withAlpha(gradient.colors[1], 0.82),
        withAlpha(gradient.colors[2], 0.82),
      ] as [string, string, string])
    : gradient.colors;

  const header = (
    <View style={styles.hero}>
      {/* Full-bleed colour banner running up under the (transparent) header,
          replacing the small colour square. White text + a bottom scrim keep it
          legible across every palette colour and arbitrary user hex. */}
      {/* Clear the native header's back + action buttons over the banner top. */}
      <View
        onLayout={handleHeroLayout}
        style={[styles.heroBanner, { paddingTop: insets.top + spacing[12] + spacing[2], backgroundColor: baseColor }]}
      >
        {showBackdrop && hero.boardType ? boardBackdrop : null}
        <LinearGradient
          pointerEvents="none"
          colors={gradientColors}
          locations={gradient.locations}
          start={GRADIENT_START}
          end={GRADIENT_END}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          pointerEvents="none"
          colors={HERO_SCRIM_COLORS}
          locations={HERO_SCRIM_LOCATIONS}
          start={GRADIENT_START}
          end={GRADIENT_END}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.heroBannerContent}>
          {heroEmojiIcon ? (
            <Text style={styles.heroEmoji} allowFontScaling={false}>
              {heroEmojiIcon}
            </Text>
          ) : (
            <Icon name="tag" size={40} color={iosSystemColors.white} />
          )}
          <View style={styles.heroNameRow}>
            <Text
              variant="title2"
              numberOfLines={2}
              color={iosSystemColors.white}
              style={[styles.heroName, styles.heroNameFlex]}
            >
              {hero.name}
            </Text>
            {renderEditDetailsCog(iosSystemColors.white)}
          </View>
          <Text variant="subheadline" color={iosSystemColors.white} style={styles.heroBannerMeta}>
            {t('detail.climbCount', { count: hero.climbCount })}
          </Text>
          {hero.followerLabel ? (
            <Text variant="footnote" color={iosSystemColors.white} style={styles.heroBannerMeta}>
              {hero.followerLabel}
            </Text>
          ) : null}
        </View>
      </View>
      {hero.description || hero.subtitle ? (
        <View style={styles.heroBelow}>
          {hero.description ? (
            <Text variant="footnote" numberOfLines={3} style={styles.heroDescription}>
              {hero.description}
            </Text>
          ) : null}
          {hero.subtitle ? (
            <Text variant="footnote" numberOfLines={1} style={styles.heroSubtitle}>
              {hero.subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    // The background paints the status-bar / dynamic-island strip in the playlist
    // colour so it is never the bare screen background, even on the first frame
    // before the list lays its full-bleed hero out behind the island. It is a
    // background rather than a sibling view so the list stays the first child:
    // react-native-screens finds the scroll view for `scrollEdgeEffects` by
    // following first children only.
    <View style={[styles.container, islandFillStyle]}>
      <ReadableColumn style={styles.container}>
        {wrapList(
          <FlashList
            ref={listRef}
            data={climbs}
            maintainVisibleContentPosition={KEEP_SCROLL_OFFSET_ON_NEW_ROWS}
            renderItem={renderItem}
            onViewableItemsChanged={onViewableItemsChanged}
            keyExtractor={keyExtractor}
            extraData={editMode}
            scrollEnabled={!isDragging}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            // The hero banner is full-bleed and runs up behind the status bar / dynamic
            // island, owning the top inset itself (paddingTop above). Both props are
            // needed so iOS doesn't inset the content down on the first frame (which
            // would briefly expose the screen background behind the island).
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            refreshControl={refreshControl}
            contentContainerStyle={{ paddingBottom: listPaddingBottom }}
            ListHeaderComponent={
              <>
                {header}
                {filterBarNode}
                {bannerNode}
                {addToQueueNode}
                {headerSlot}
              </>
            }
            ListFooterComponent={listFooterComponent}
            ListEmptyComponent={listEmptyComponent}
          />,
        )}
      </ReadableColumn>

      {/* Collapsed header bar — a progressive blur (matching the tabs' chrome)
          carrying the centered name, fading in once the hero scrolls off. Sits
          under the transparent native header and its buttons. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.headerBar, { height: headerBarHeight, paddingTop: insets.top }, headerBarStyle]}
      >
        <ProgressiveBlur style={StyleSheet.absoluteFill} />
        <View style={styles.headerBarRow}>
          <Text variant="headline" numberOfLines={1} color={systemColors.label} style={styles.headerBarTitle}>
            {hero.name}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

/** Centered Material empty state: tonal icon + headline + supporting copy, plus
 *  an optional CTA. */
function MaterialEmptyState({
  icon,
  title,
  supporting,
  action,
  titleColor,
  supportingColor,
}: {
  icon: IconName;
  title: string;
  supporting?: string;
  action?: PlaylistDetailEmptyAction;
  titleColor: ColorValue;
  supportingColor: ColorValue;
}) {
  const styles = useTypographyStyles(createStyles);
  return (
    <View style={styles.stateContainer}>
      <View accessibilityRole="image" accessibilityLabel={title}>
        <Icon name={icon} size={48} color={supportingColor} />
      </View>
      <Text variant="headline" color={titleColor} style={styles.materialEmptyTitle}>
        {title}
      </Text>
      {supporting ? (
        <Text variant="subheadline" color={supportingColor} style={styles.materialEmptySupporting}>
          {supporting}
        </Text>
      ) : null}
      {action ? (
        <Button
          title={action.label}
          onPress={action.onPress}
          size="medium"
          icon={action.icon}
          style={styles.emptyActionButton}
          ignoreContainerSafeArea
        />
      ) : null}
    </View>
  );
}

/** Switch-board banner for a playlist whose board differs from the active one:
 *  a board glyph + the prompt, then a filled CTA into `/boards`. */
function BoardMismatchBanner({
  banner,
  systemColors,
}: {
  banner: PlaylistBoardBanner;
  systemColors: {
    secondaryBackground: ColorValue;
    label: ColorValue;
    secondaryLabel: ColorValue;
    separator: ColorValue;
  };
}) {
  const styles = useTypographyStyles(createStyles);
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
      ]}
    >
      <View style={styles.bannerRow}>
        <Icon name="boards.fill" size={22} color={systemColors.secondaryLabel} />
        <View style={styles.bannerText}>
          <Text variant="subheadline" color={systemColors.label} style={styles.bannerTitle}>
            {banner.title}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {banner.subtitle}
          </Text>
        </View>
      </View>
      {/* The banner scrolls with the list, so its native button can sit above
          the screen; without this it keeps the top safe-area inset and draws
          its label below its own frame once scrolled back. */}
      <Button
        title={banner.cta}
        onPress={banner.onPress}
        size="medium"
        style={styles.bannerButton}
        ignoreContainerSafeArea
      />
    </View>
  );
}

const keyExtractor = (climb: Climb) => climb.uuid;
