import { type ReactNode, useCallback, useState } from 'react';
import {
  type ColorValue,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
  StyleSheet,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Appbar, Menu } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb as SchemaClimb } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName, iconMap } from '../icon-map';
import { ActivityIndicator } from '../ActivityIndicator';
import { ClimbListRow } from '../ClimbListRow';
import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import { GlassIconButton } from '../GlassIconButton';
import { PlaylistBoardBackdrop } from './PlaylistBoardBackdrop';
import { buildHeroGradient, shiftLightness } from './playlist-gradient';
import { PLAYLIST_COLORS, isValidHexColor } from './playlist-colors';
import { withAlpha } from '../../theme/colors';
import { toQueueClimb, toSchemaClimb } from '../../lib/climb-types';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { glassSize } from '../../theme/layout';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { SKELETON_PLACEHOLDERS } from './skeleton-placeholders';

/** Bottom scrim that keeps white title/meta legible across the palette (amber
 *  and green included) without per-colour luminance branching. */
const HERO_SCRIM_COLORS = ['transparent', 'transparent', 'rgba(0, 0, 0, 0.28)'] as const;
const HERO_SCRIM_LOCATIONS = [0, 0.45, 1] as const;
const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 1 } as const;
/** Nav-bar height (below the status-bar inset) for the collapsed header — tall
 *  enough to contain the floating FABs (which sit `spacing[1]` below the inset),
 *  so they're centered in the bar rather than poking out under it. */
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

/** A primary owner/viewer control rendered as a Paper `Appbar.Action` in the
 *  Material header (e.g. follow, pin). Mirrors a glass action FAB. */
export type PlaylistMaterialAction = {
  /** Stable React key. */
  key: string;
  /** Semantic icon name, mapped to its MaterialCommunityIcons glyph for Paper. */
  icon: IconName;
  /** Already-translated accessibility label. */
  accessibilityLabel: string;
  onPress: () => void;
  /** When set, tints the action (e.g. the brand colour for a pinned playlist). */
  tint?: ColorValue;
  /** Disables the action while a request is in flight (e.g. follow toggling). */
  disabled?: boolean;
};

/** An item inside the Material header's overflow (`dots-vertical`) `Menu` — the
 *  owner edit/delete controls the glass branch exposes via its more-FAB sheet. */
export type PlaylistMaterialMenuItem = {
  key: string;
  /** Already-translated row label. */
  title: string;
  icon: IconName;
  onPress: () => void;
  /** Renders the row in the destructive (red) tone, e.g. Delete. */
  destructive?: boolean;
};

/** Material-branch action set. `inline` actions become `Appbar.Action`s; `menu`
 *  items (if any) hang off a trailing overflow `Menu`. The glass branch ignores
 *  this and renders its `actions` render-prop FABs instead. */
export type PlaylistMaterialActions = {
  inline?: PlaylistMaterialAction[];
  menu?: PlaylistMaterialMenuItem[];
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

export type PlaylistDetailViewProps = {
  hero: PlaylistDetailHero;
  climbs: Climb[];
  /** True while the first page loads (hero still renders; list shows a spinner). */
  isLoading: boolean;
  /** True while a subsequent page loads (trailing spinner). */
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  /** Activate a tapped climb (wires the queue + opens the play drawer). */
  onActivateClimb: (climb: Climb) => void;
  /** Already-resolved empty-list copy (callers translate with a static key). */
  emptyMessage: string;
  /** Richer Material-branch empty state (e.g. the liked-climbs heart prompt).
   *  Glass branch ignores this and keeps `emptyMessage`. */
  emptyState?: PlaylistDetailEmptyState;
  /** Floating top-right controls (follow / pin / more) over the hero, given the
   *  current collapse state so a control can swap to its compact icon form once
   *  the colour header bar takes over. The back FAB on the left is always
   *  rendered; absent here = a back-only top bar. */
  actions?: (collapsed: boolean) => ReactNode;
  /** Material-branch equivalent of `actions`. The glass branch can't share the
   *  same nodes (its FABs are glass surfaces), so the Material header renders
   *  these structured descriptors as Paper `Appbar.Action`s + an overflow
   *  `Menu`. Absent here = a back-only Material header. */
  materialActions?: PlaylistMaterialActions;
};

/**
 * Shared hero + paginated climb list for the playlist-detail and
 * smart-playlist-detail screens. Renders the colour/emoji hero, then a FlashList
 * of `ClimbListRow`s bound to the user's active board, paginating via
 * `fetchNextPage` as the list nears its end.
 *
 * Two presentations: the Liquid Glass variant keeps the full-bleed gradient hero
 * with white text and floating FABs; the Material 3 variant swaps in a Paper
 * `Appbar.Header` over a tonal hero band. Both share the scroll math, FlashList,
 * list state, and row rendering — only the hero chrome + state visuals branch.
 */
export function PlaylistDetailView({
  hero,
  climbs,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  onActivateClimb,
  emptyMessage,
  emptyState,
  actions,
  materialActions,
}: PlaylistDetailViewProps) {
  const { t } = useTranslation('playlists');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors, variant } = useTheme();
  const { boardConfig } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const listPaddingBottom = bottomChrome.scrollBottomPadding;
  const isMaterial = variant === 'material';

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
  const headerBarStyle = useAnimatedStyle(() => {
    const banner = heroBannerHeight.value;
    if (banner <= 0) return { opacity: 0 };
    // Fully opaque once the banner's bottom edge reaches the bar's bottom.
    const threshold = Math.max(1, banner - headerBarHeight);
    return { opacity: interpolate(scrollY.value, [threshold - 24, threshold], [0, 1], Extrapolation.CLAMP) };
  });

  // `collapsed` flips when the colour header bar takes over, so action FABs (e.g.
  // follow) can swap to their compact icon form. On Material it drives the app-bar
  // title fade-in.
  const [collapsed, setCollapsed] = useState(false);
  useAnimatedReaction(
    () => {
      const banner = heroBannerHeight.value;
      return banner > 0 && scrollY.value >= banner - headerBarHeight;
    },
    (isCollapsed, wasCollapsed) => {
      if (isCollapsed !== wasCollapsed) runOnJS(setCollapsed)(isCollapsed);
    },
  );
  const actionNode = actions?.(collapsed);

  // Material overflow `Menu` open state (owner edit/delete). Only used when the
  // Material branch is active and `materialActions.menu` is non-empty.
  const [menuVisible, setMenuVisible] = useState(false);
  const openMenu = useCallback(() => setMenuVisible(true), []);
  const closeMenu = useCallback(() => setMenuVisible(false), []);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Stable per-row activate handler so the memoized `ClimbListRow`s aren't handed
  // a fresh closure each render — every renderItem rebuild (e.g. when the sticky
  // header `collapsed` flips during scroll) would otherwise re-render every row.
  const handleActivate = useCallback((tapped: SchemaClimb) => onActivateClimb(toQueueClimb(tapped)), [onActivateClimb]);

  // Activate-all: queue the playlist from the top. Reuses the same row-tap path
  // (which seeds the suggestion source from the whole list), so swiping the play
  // drawer walks the playlist. No-op on an empty list.
  const handleActivateAll = useCallback(() => {
    const first = climbs[0];
    if (first) onActivateClimb(first);
  }, [climbs, onActivateClimb]);

  const renderItem = useCallback(
    ({ item }: { item: Climb }) => {
      if (!boardConfig) return null;
      return (
        <ClimbListRow
          climb={toSchemaClimb(item)}
          boardName={boardConfig.boardName as BoardName}
          layoutId={boardConfig.layoutId}
          sizeId={boardConfig.sizeId}
          setIds={boardConfig.setIds}
          angle={boardConfig.angle}
          onPress={handleActivate}
        />
      );
    },
    [boardConfig, handleActivate],
  );

  const baseColor = hero.color && isValidHexColor(hero.color) ? hero.color : PLAYLIST_COLORS[0];

  // Shared list state visuals. The first-page load renders skeleton rows (a far
  // better "shape of what's coming" cue than a bare spinner). Empty + footer are
  // shared; the empty body is variant-aware below.
  const listEmptyComponent = isLoading ? (
    <View style={styles.skeletonList}>
      {SKELETON_PLACEHOLDERS.map((key) => (
        <ClimbListRowSkeleton key={key} />
      ))}
    </View>
  ) : isMaterial ? (
    <MaterialEmptyState
      icon={emptyState?.icon ?? 'playlist'}
      title={emptyState?.title ?? emptyMessage}
      supporting={emptyState?.supporting}
      titleColor={systemColors.label}
      supportingColor={systemColors.secondaryLabel}
    />
  ) : (
    <View style={styles.stateContainer}>
      <Icon name="playlist" size={44} color={iosSystemColors.systemGray4} />
      <Text variant="subheadline" style={styles.emptyText}>
        {emptyMessage}
      </Text>
    </View>
  );

  const listFooterComponent = isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator size="small" />
    </View>
  ) : null;

  // ── Material 3 branch ───────────────────────────────────────────────────────
  if (isMaterial) {
    const accent = brandColors.primary;
    return (
      <View style={[styles.container, { backgroundColor: systemColors.background }]}>
        <FlashList
          data={climbs}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: listPaddingBottom }}
          ListHeaderComponent={
            <View onLayout={handleHeroLayout} style={styles.materialHero}>
              <View
                style={[
                  styles.materialHeroBand,
                  { paddingTop: headerBarHeight + spacing[4], backgroundColor: systemColors.secondaryBackground },
                ]}
              >
                <View style={[styles.materialHeroEmojiCircle, { backgroundColor: systemColors.tertiaryBackground }]}>
                  {hero.icon ? (
                    <Text style={styles.materialHeroEmoji} allowFontScaling={false}>
                      {hero.icon}
                    </Text>
                  ) : (
                    <Icon name="tag" size={36} color={systemColors.secondaryLabel} />
                  )}
                </View>
                <Text variant="title2" numberOfLines={2} color={systemColors.label} style={styles.materialHeroName}>
                  {hero.name}
                </Text>
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
                    <Text variant="footnote" numberOfLines={1} color={systemColors.tertiaryLabel}>
                      {hero.subtitle}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          }
          ListFooterComponent={listFooterComponent}
          ListEmptyComponent={listEmptyComponent}
        />

        {/* Collapsing M3 top app bar — sits over the hero band; its title fades in
            as the band scrolls under it, then the band's name is hidden behind. */}
        <Appbar.Header
          statusBarHeight={insets.top}
          mode="small"
          style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <Appbar.BackAction
            onPress={() => router.back()}
            color={systemColors.label as string}
            rippleColor={withAlpha(accent, 0.16)}
            accessibilityLabel={tCommon('ariaLabels.back')}
          />
          <Animated.View style={[styles.materialAppbarTitle, headerBarStyle]}>
            <Appbar.Content title={hero.name} titleStyle={styles.materialAppbarTitleText} />
          </Animated.View>
          {climbs.length > 0 ? (
            <Appbar.Action
              icon="play"
              color={accent as string}
              rippleColor={withAlpha(accent, 0.16)}
              onPress={handleActivateAll}
              accessibilityLabel={t('detail.activateAll')}
            />
          ) : null}
          {/* Owner/viewer controls (follow, pin) the glass branch floats over the
              hero, surfaced here as Paper actions so Material owners keep them. */}
          {materialActions?.inline?.map((action) => (
            <Appbar.Action
              key={action.key}
              icon={iconMap[action.icon].android}
              color={(action.tint ?? systemColors.label) as string}
              rippleColor={withAlpha(accent, 0.16)}
              onPress={action.onPress}
              disabled={action.disabled}
              accessibilityLabel={action.accessibilityLabel}
            />
          ))}
          {/* Overflow menu for the owner edit/delete actions the glass branch
              opens via its more-FAB bottom sheet. */}
          {materialActions?.menu && materialActions.menu.length > 0 ? (
            <Menu
              visible={menuVisible}
              onDismiss={closeMenu}
              anchor={
                <Appbar.Action
                  icon="dots-vertical"
                  color={systemColors.label as string}
                  rippleColor={withAlpha(accent, 0.16)}
                  onPress={openMenu}
                  accessibilityLabel={t('detail.actions')}
                />
              }
              contentStyle={{ backgroundColor: systemColors.elevatedSurface }}
            >
              {materialActions.menu.map((item) => (
                <Menu.Item
                  key={item.key}
                  title={item.title}
                  leadingIcon={iconMap[item.icon].android}
                  titleStyle={{
                    color: (item.destructive ? iosSystemColors.systemRed : systemColors.label) as string,
                  }}
                  onPress={() => {
                    closeMenu();
                    item.onPress();
                  }}
                />
              ))}
            </Menu>
          ) : null}
        </Appbar.Header>
      </View>
    );
  }

  // ── Liquid Glass branch (unchanged) ─────────────────────────────────────────
  // The collapsed bar uses the gradient's deeper tone so white text stays legible.
  const headerColor = shiftLightness(baseColor, -20);
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
      {/* Clear the floating back + action FABs that sit over the banner top. */}
      <View
        onLayout={handleHeroLayout}
        style={[styles.heroBanner, { paddingTop: insets.top + spacing[12] + spacing[2], backgroundColor: baseColor }]}
      >
        {showBackdrop && hero.boardType ? (
          <PlaylistBoardBackdrop boardType={hero.boardType} layoutId={hero.layoutId} />
        ) : null}
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
          {hero.icon ? (
            <Text style={styles.heroEmoji} allowFontScaling={false}>
              {hero.icon}
            </Text>
          ) : (
            <Icon name="tag" size={40} color={iosSystemColors.white} />
          )}
          <Text variant="title2" numberOfLines={2} color={iosSystemColors.white} style={styles.heroName}>
            {hero.name}
          </Text>
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
    <View style={styles.container}>
      {/* Paints the status-bar / dynamic-island strip in the playlist colour so it
          is never the bare screen background — even on the first frame before the
          list lays its full-bleed hero out behind the island. */}
      <View pointerEvents="none" style={[styles.islandFill, { height: insets.top, backgroundColor: baseColor }]} />
      <FlashList
        data={climbs}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
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
        contentContainerStyle={{ paddingBottom: listPaddingBottom }}
        ListHeaderComponent={header}
        ListFooterComponent={listFooterComponent}
        ListEmptyComponent={listEmptyComponent}
      />

      {/* Collapsed colour header bar — the playlist colour + centered name, fading
          in once the hero scrolls off. Sits below the floating FABs. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.headerBar,
          { height: headerBarHeight, paddingTop: insets.top, backgroundColor: headerColor },
          headerBarStyle,
        ]}
      >
        <View style={styles.headerBarRow}>
          <Text variant="headline" numberOfLines={1} color={iosSystemColors.white} style={styles.headerBarTitle}>
            {hero.name}
          </Text>
        </View>
      </Animated.View>

      {/* Floating top bar over the gradient hero — replaces the native header.
          Back chevron on the left, optional follow/pin/more on the right. */}
      <View pointerEvents="box-none" style={[styles.topBar, { paddingTop: insets.top + spacing[1] }]}>
        <GlassIconButton
          iconName="back"
          iconColor={systemColors.label}
          onPress={() => router.back()}
          accessibilityLabel={tCommon('ariaLabels.back')}
          fallbackColor={systemColors.fill}
        />
        {actionNode ? (
          <View pointerEvents="box-none" style={styles.topBarActions}>
            {actionNode}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Centered Material empty state: tonal icon + headline + supporting copy. */
function MaterialEmptyState({
  icon,
  title,
  supporting,
  titleColor,
  supportingColor,
}: {
  icon: IconName;
  title: string;
  supporting?: string;
  titleColor: ColorValue;
  supportingColor: ColorValue;
}) {
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
    </View>
  );
}

function keyExtractor(item: Climb) {
  return item.uuid;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  islandFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  headerBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0, 0, 0, 0.15)',
  },
  headerBarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Keep the centered name clear of the back / action FABs at the edges.
    paddingHorizontal: 64,
  },
  headerBarTitle: {
    fontWeight: '600',
    textShadowColor: 'rgba(0, 0, 0, 0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
  },
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  hero: {
    marginBottom: spacing[2],
  },
  heroBanner: {
    borderBottomLeftRadius: borderRadius.xl,
    borderBottomRightRadius: borderRadius.xl,
    overflow: 'hidden',
    paddingBottom: spacing[5],
  },
  heroBannerContent: {
    paddingHorizontal: spacing[4],
  },
  heroEmoji: {
    fontSize: 52,
    lineHeight: 60,
    marginBottom: spacing[2],
  },
  heroName: {
    textShadowColor: 'rgba(0, 0, 0, 0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  heroBannerMeta: {
    marginTop: 2,
    opacity: 0.85,
  },
  heroBelow: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[5],
    gap: 2,
  },
  heroSubtitle: {
    opacity: 0.5,
  },
  heroDescription: {
    opacity: 0.7,
  },
  // ── Material hero ──────────────────────────────────────────────────────────
  materialAppbar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    elevation: 0,
  },
  // Wraps Appbar.Content so the title can fade in (opacity-animated) as the hero
  // band scrolls under the bar, without animating the back / play actions.
  materialAppbarTitle: {
    flex: 1,
  },
  materialAppbarTitleText: {
    fontSize: 18,
    fontWeight: '600',
  },
  materialHero: {
    marginBottom: spacing[2],
  },
  materialHeroBand: {
    alignItems: 'center',
    paddingHorizontal: spacing[5],
    paddingBottom: spacing[6],
    borderBottomLeftRadius: borderRadius.xl,
    borderBottomRightRadius: borderRadius.xl,
  },
  materialHeroEmojiCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[3],
  },
  materialHeroEmoji: {
    fontSize: 36,
    lineHeight: 44,
  },
  materialHeroName: {
    textAlign: 'center',
  },
  materialHeroMeta: {
    marginTop: 2,
    textAlign: 'center',
  },
  materialEmptyTitle: {
    textAlign: 'center',
  },
  materialEmptySupporting: {
    textAlign: 'center',
  },
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  skeletonList: {
    paddingTop: spacing[2],
  },
  stateContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyText: {
    opacity: 0.5,
    textAlign: 'center',
  },
});
