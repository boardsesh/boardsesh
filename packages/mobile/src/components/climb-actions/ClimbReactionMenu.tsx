import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  Modal,
  type OpaqueColorValue,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { GlassSurface } from '../GlassSurface';
import { BoardImageNative } from '../BoardImageNative';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { InlinePlaylistPicker } from '../playlist/InlinePlaylistPicker';
import { getBoardRenderData } from '../../lib/board-details';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { springs, timing } from '../../theme/animations';
import { spacing, borderRadius } from '../../theme/tokens';
import { withAlpha, type MaterialSurfaceContainers } from '../../theme/colors';
import { useEffectiveSurfaceMode } from '../../hooks/use-effective-surface-mode';
import { useClimbActions, type ClimbActionId, type ClimbActionItem } from './use-climb-actions';
import type { DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { fitBoardArt, computeReactionBoardMaxSize } from './board-art-fit';

// Log a tick / Add to playlist / Share get pulled out of the scrollable list into a
// fixed horizontal button row at the top of the card — the most-reached actions,
// one tap away. The rest stay in the list below. Order here is the row order.
const PRIMARY_ACTION_IDS: readonly ClimbActionId[] = ['tick', 'playlist', 'share'];

type ClimbReactionMenuProps = {
  climb: Climb;
  boardConfig: BoardConfig;
  /** Set only when the menu was opened from a queue row — names the exact slot
   *  "Play next" should move, which matters when a climb is queued twice. */
  queueItemUuid?: string;
  currentUserId?: string | null;
  isAuthenticated: boolean;
  onEditEntry?: () => void;
  /** When provided, the "Add beta video" action runs this instead of opening the
   *  root beta sheet — the play drawer passes its own in-tree opener so the sheet
   *  stacks above the `/play` modal (#3505). Receives the climb/board snapshot the
   *  menu was opened for. */
  onAddBetaVideo?: (climb: Climb, boardConfig: BoardConfig) => void;
  /** When provided, the "Tick" action runs this instead of opening the root
   *  LogAscent sheet — the play drawer passes its own in-tree opener so the tick
   *  sheet stacks above the `/play` modal. Without it, presenting the root sheet
   *  forces UIKit to dismiss `/play` and the tick sheet closes immediately.
   *  Receives the climb/board snapshot the menu was opened for. */
  onTick?: (climb: Climb, boardConfig: BoardConfig) => void;
  /** Native sheet underneath this custom overlay, if any. */
  dismissSourceSheet?: DismissSurfaceAndWait;
  /** Supplied only when this menu was opened from the `/play` route. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
  /** Read once at the app root (resolved) and passed in, so the mount-time enter
   *  animation uses the real value rather than useReduceMotion's conservative default. */
  reduceMotion: boolean;
  onClose: () => void;
};

// Frame width shared by the preview and the action card, and the ceiling the hero art
// is clamped to so an explicit art width can't bleed past the (unclipped) preview frame.
// Wide enough that on a phone the board + card fill the screen width (bounded by the
// content's horizontal padding); on tablets this caps how wide the floating card gets.
const PREVIEW_MAX_WIDTH = 400;

// The card is a modal, scrim-dimming, non-anchored overlay — an M3 dialog — so on
// Material it takes the surface-container-high tone and a level-3 cast. Named here
// because the bottom fade has to read the same tone; see MENU_FADE_COLORS.
const MENU_CARD_ROLE: keyof MaterialSurfaceContainers = 'high';

// The card's own tone off Material — there is no opaque M3 tone to read there,
// the card is real glass, so this is a tuned approximation (#14111F dark).
// Single source for both the fade (below) and the opaque backdrop/board-art
// fill, so the two can't drift apart if this ever gets re-tuned.
const MENU_CARD_BASE_RGB = {
  dark: '20, 17, 31',
  light: '255, 255, 255',
} as const;

// Bottom-edge fade for the scrollable action list — transparent → the card's own
// surface. Concrete rgba, never a systemColors PlatformColor: feeding a PlatformColor
// into the gradient bakes the wrong scheme (the ProgressiveBlur dark-band bug). On
// Material the stops are derived from the very tone GlassSurface paints the card with,
// so bumping MENU_CARD_ROLE can't leave the fade behind. Glass / blur / solid keep the
// tuned constants from MENU_CARD_BASE_RGB.
const MENU_FADE_END_ALPHA = 0.92;
const MENU_FADE_COLORS = {
  dark: [`rgba(${MENU_CARD_BASE_RGB.dark}, 0)`, `rgba(${MENU_CARD_BASE_RGB.dark}, ${MENU_FADE_END_ALPHA})`],
  light: [`rgba(${MENU_CARD_BASE_RGB.light}, 0)`, `rgba(${MENU_CARD_BASE_RGB.light}, ${MENU_FADE_END_ALPHA})`],
} as const;

// The card's own tone, fully opaque — reused as the backdrop and board-art
// backing so both read as the same surface instead of a mismatched theme
// color. Same Material-vs-glass split as the fade.
const MENU_CARD_SOLID = {
  dark: `rgb(${MENU_CARD_BASE_RGB.dark})`,
  light: `rgb(${MENU_CARD_BASE_RGB.light})`,
} as const;

// iOS portals above the persistent queue bar / tab bar via a native window overlay;
// Android uses a transparent Modal (which also gives a hardware-back handler).
function OverlayPortal({ children, onRequestClose }: { children: React.ReactNode; onRequestClose: () => void }) {
  if (Platform.OS === 'ios') return <FullWindowOverlay>{children}</FullWindowOverlay>;
  return (
    <Modal transparent statusBarTranslucent visible animationType="none" onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}

/**
 * iMessage-style long-press reaction overlay: the climb floats, scaled up, over a
 * backdrop painted the menu card's own tone, with the climb-action menu floating
 * beside it. Built with Reanimated so we control the enlargement, the animation,
 * and the layout — the native context-menu library can't host a custom enlarged
 * preview on RN's New Architecture (the preview leaks into the row). Used for
 * every list long-press via the provider's `openClimbActions`; PlayDrawer keeps
 * its own bottom sheet.
 *
 * Mounted only while open; the enter animation runs on mount (using the passed
 * `reduceMotion`), and dismissal animates out before calling `onClose`. Actions come
 * from the shared `useClimbActions` hook — the same list the bottom sheet renders.
 */
export function ClimbReactionMenu({
  climb,
  boardConfig,
  queueItemUuid,
  currentUserId,
  isAuthenticated,
  onEditEntry,
  onAddBetaVideo,
  onTick,
  dismissSourceSheet,
  dismissPlayerAndWait,
  reduceMotion,
  onClose,
}: ClimbReactionMenuProps) {
  const { colorScheme, systemColors, m3SurfaceContainers } = useTheme();
  const { t } = useTranslation('climbs');
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  const { formatGrade } = useGradeFormat();
  const surfaceMode = useEffectiveSurfaceMode();

  const progress = useSharedValue(0);
  // 'menu' shows the action list; 'playlist' swaps the card to the inline
  // playlist picker (no second sheet — that's the #3294 fix).
  const [view, setView] = useState<'menu' | 'playlist'>('menu');

  const finishClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    progress.value = reduceMotion ? 1 : withSpring(1, springs.gentle);
  }, [progress, reduceMotion]);

  const dismiss = useCallback(() => {
    if (reduceMotion) {
      finishClose();
      return;
    }
    progress.value = withTiming(0, { duration: timing.fast }, (finished) => {
      if (finished) runOnJS(finishClose)();
    });
  }, [progress, reduceMotion, finishClose]);

  const backToMenu = useCallback(() => setView('menu'), []);
  // Stable so useClimbActions' memo doesn't rebuild the action list every render.
  const openPlaylist = useCallback(() => setView('playlist'), []);

  // A playlist add/remove that fails after the picker is gone but while THIS
  // overlay is still up (back-to-menu unmounts the picker; the overlay stays).
  // A toast fired now would render behind the FullWindowOverlay / Modal and
  // auto-dismiss after 3s, so hold the message and fire it on the way out — the
  // unmount cleanup covers both dismissal and the parent tearing us down. Ref'd
  // showToast so the cleanup effect never re-runs and flushes early (#3891).
  //
  // Holding only works while there is still a cleanup to come. Dismiss the whole
  // overlay while the request is in flight and the cleanup has already run by the
  // time the rejection lands — writing to the ref then would park the message in a
  // dead component forever. `overlayGoneRef` records that we are past cleanup, and
  // a message arriving after it goes straight to the toast, which by then is the
  // top layer anyway.
  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const pendingFailureRef = useRef<string | null>(null);
  const overlayGoneRef = useRef(false);
  const holdFailureUntilDismissed = useCallback((message: string) => {
    if (overlayGoneRef.current) {
      showToastRef.current(message, 'error');
      return;
    }
    pendingFailureRef.current = message;
  }, []);
  useEffect(() => {
    // Reset on mount as well as set on unmount: a mount/cleanup/mount cycle
    // (StrictMode, Fast Refresh) would otherwise leave a live overlay classified as
    // gone, toasting failures behind itself where nobody sees them.
    overlayGoneRef.current = false;
    return () => {
      overlayGoneRef.current = true;
      const pendingFailure = pendingFailureRef.current;
      pendingFailureRef.current = null;
      if (pendingFailure) showToastRef.current(pendingFailure, 'error');
    };
  }, []);

  // Hardware back (Android) / VoiceOver escape: pop the playlist view first,
  // dismiss the whole overlay only from the top-level menu.
  const handleRequestClose = useCallback(() => {
    if (view === 'playlist') {
      backToMenu();
      return;
    }
    dismiss();
  }, [view, backToMenu, dismiss]);

  // DrawerHost conditionally mounts this overlay only while an action target is
  // present, so every open gets a fresh create-navigation double-tap guard. The
  // guard intentionally stays claimed throughout this instance's exit animation.
  const actions = useClimbActions({
    climb,
    boardConfig,
    queueItemUuid,
    currentUserId,
    isAuthenticated,
    onEditEntry,
    onAfterAction: dismiss,
    onSelectPlaylist: openPlaylist,
    onAddBetaVideo,
    onTick,
    dismissSourceSheet,
    dismissPlayerAndWait,
  });

  // Split the actions into the fixed top button row (tick / playlist / share, in that
  // order) and the scrollable remainder. Both preserve `useClimbActions`' identity so
  // they only rebuild when the action list itself changes.
  const primaryActions = useMemo(() => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return PRIMARY_ACTION_IDS.map((id) => byId.get(id)).filter((action): action is ClimbActionItem => action != null);
  }, [actions]);
  const listActions = useMemo(() => actions.filter((action) => !PRIMARY_ACTION_IDS.includes(action.id)), [actions]);

  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty);

  // Subtle byline under the name: sends · quality★ · setter (each dropped when
  // absent). Mirrors the climb-list row's primary subtitle.
  const byline = useMemo(() => {
    const parts: string[] = [];
    if (!climb.is_draft && climb.ascensionist_count) parts.push(formatSends(climb.ascensionist_count, t));
    if (parseFloat(climb.quality_average) > 0) parts.push(`${formatQuality(climb.quality_average)}★`);
    if (climb.setter_username) parts.push(climb.setter_username);
    return parts.join(' · ');
  }, [climb.is_draft, climb.ascensionist_count, climb.quality_average, climb.setter_username, t]);

  // Track the keyboard height (the inline create form focuses a TextInput). When it's
  // up, the card's bottom must sit at the keyboard's top (not the screen's), and the
  // climb art shrinks so the preview + form still fit above it on shorter phones.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    // iOS `will*` events fire before the animation (and don't exist on Android);
    // Android only fires the `did*` pair. Read the keyboard height straight off the
    // event (absolute — no windowHeight), so empty deps: on Android `adjustResize`
    // the keyboard shrinks windowHeight, and a windowHeight dep would tear down and
    // re-register this listener mid-event and miss it.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (event) => setKeyboardHeight(event.endCoordinates?.height ?? 0));
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  const boardRenderData = useMemo(() => {
    const setIdValues = boardConfig.setIds
      .split(',')
      .map((setIdText) => Number(setIdText))
      .filter((setIdValue) => Number.isFinite(setIdValue));
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: setIdValues,
    });
  }, [boardConfig]);

  // Board aspect (w/h), read once for the sizing math + the worklet below. Sanitised
  // to 1 for degenerate dims so the worklet can't collapse the art to a zero edge.
  const rawAspect = boardRenderData ? boardRenderData.boardWidth / boardRenderData.boardHeight : 1;
  const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1;

  // Small breathing room below the top safe area — the preview sits just under the
  // status bar so the top isn't wasted and the action list gets more room below.
  const contentTopOffset = Math.round(windowHeight * 0.02);
  // Row height for the action list (ListRow: minHeight 44 + 12pt vertical padding, text
  // growing with fontScale). The whole list is shown without scrolling, so its full
  // height is reserved up front and the board takes whatever space is left below it.
  const actionRowHeight = Math.max(44, Math.round(24 + 22 * fontScale));
  const listContentHeight = listActions.length * actionRowHeight + spacing[1] * 2;
  // Height of the fixed primary-action button row, reserved out of the card so the list
  // cap is accurate. Measured via onLayout (fires only on layout change, not per frame)
  // so a large Dynamic Type / RTL wrap can't over- or under-reserve; the fontScale-scaled
  // estimate stands in for the first frame before the measurement lands. Zero when there
  // are no primary actions.
  const primaryRowHeightEstimate = primaryActions.length > 0 ? Math.round(84 + 26 * fontScale) : 0;
  const [measuredPrimaryRowHeight, setMeasuredPrimaryRowHeight] = useState(0);
  const primaryRowHeight = primaryActions.length === 0 ? 0 : measuredPrimaryRowHeight || primaryRowHeightEstimate;
  const handlePrimaryRowLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    // Gate the setState on a real change so a re-render can't loop through onLayout.
    setMeasuredPrimaryRowHeight((previous) => (previous === height ? previous : height));
  }, []);

  // Enlarged board art. Rendered at play-drawer quality — full-res board photo and a
  // holds overlay sized to the displayed width × DPR (see overlayRenderWidth below) —
  // rather than piggybacking the tiny list-thumbnail cache, so the hero stays crisp.
  // The menu view shows a large hero; a sub-action that stays inline (the playlist
  // picker) shrinks it to the compact "current" size.
  //
  // name+byline reserve, an estimate (not an onLayout measurement) so resizing the art
  // never re-renders the menu (see reservedForPreview). Scaled by fontScale so a large
  // Dynamic Type setting reserves the taller text instead of overlapping the art.
  const previewTextReserve = Math.round(56 * fontScale);
  // Size the board the way the play drawer does — contain-fit into the space left after
  // the title, button row and full list are reserved, so it renders SMALLER on smaller
  // screens instead of crowding the actions off the bottom. Bounds/floor live in the pure
  // computeReactionBoardMaxSize, which is unit-tested across device sizes.
  const largeArtMaxSize = computeReactionBoardMaxSize({
    windowWidth,
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    contentTopOffset,
    sectionGap: spacing[5],
    sideMargin: spacing[6],
    previewMaxWidth: PREVIEW_MAX_WIDTH,
    aspect,
    primaryRowHeight,
    listContentHeight,
    textReserve: previewTextReserve,
    rowHeight: actionRowHeight,
  });
  // Rasterize the holds overlay at the large hero's displayed width × DPR — matching
  // the play drawer (SwipeBoardCarousel) instead of the list-thumbnail's fixed 400px,
  // so the enlarged art stays crisp. Derived from the large size (not the animating
  // one) so the cache key is stable as the hero springs between large and compact;
  // useNativeClimbRender clamps it to the board's native width and never upscales.
  const largeArtWidth = boardRenderData
    ? fitBoardArt(boardRenderData.boardWidth, boardRenderData.boardHeight, largeArtMaxSize).width
    : largeArtMaxSize;
  const overlayRenderWidth = Math.round(largeArtWidth * PixelRatio.get());
  // compactArtMaxSize: the shrunk size used only when the create-playlist keyboard is up,
  // so the board + form + keyboard still fit. Otherwise the board keeps its full size.
  const compactArtMaxSize = Math.min(Math.round(windowHeight * 0.18), Math.round(windowWidth * 0.66));
  // The board stays the same size across the menu and the Add-to-playlist view — the
  // difference wasn't worth the jump. It only shrinks when the create-playlist form's
  // keyboard is up (playlist view + keyboardHeight > 0), to keep the form reachable.
  const targetArtMax = view === 'playlist' && keyboardHeight > 0 ? compactArtMaxSize : largeArtMaxSize;

  // The animating max-size (px). Springs between large (menu) and compact (sub-action)
  // whenever the view — or the keyboard height feeding compactArtMaxSize — changes, so
  // opening "Add to playlist" glides the hero down to the current size (and back). Seeded
  // with the current target so the first frame is right and the mount effect is a no-op.
  const artSizePx = useSharedValue(targetArtMax);
  useEffect(() => {
    artSizePx.value = reduceMotion ? targetArtMax : withSpring(targetArtMax, springs.gentle);
  }, [artSizePx, targetArtMax, reduceMotion]);

  // Derive the fitted width/height on the UI thread, mirroring fitBoardArt's aspect math
  // so the preview never distorts as it resizes.
  const animatedArtStyle = useAnimatedStyle(() => {
    const maxSize = artSizePx.value;
    return aspect >= 1 ? { width: maxSize, height: maxSize / aspect } : { width: maxSize * aspect, height: maxSize };
  });

  // Cap the menu/picker to the space under the hero. Derived from the TARGET art size,
  // not an onLayout measurement of the animating art — measuring would setState every
  // spring frame and re-render the menu + FlatList mid-shrink. The target changes only
  // on a discrete view/keyboard change, so the cap settles in one render.
  const targetArtHeight = boardRenderData
    ? fitBoardArt(boardRenderData.boardWidth, boardRenderData.boardHeight, targetArtMax).height
    : targetArtMax;
  const reservedForPreview = targetArtHeight + previewTextReserve;
  const bottomReserve = keyboardHeight > 0 ? keyboardHeight : insets.bottom + spacing[5];
  const menuMaxHeight = Math.max(
    actionRowHeight,
    windowHeight - insets.top - contentTopOffset - spacing[5] - reservedForPreview - bottomReserve,
  );

  // The list (below the fixed primary-button row) gets the card height minus that row.
  // Its full height was reserved when sizing the board, so it normally shows every row
  // without scrolling; only a floored board on a small phone leaves it short, in which
  // case it scrolls and the bottom fade cues more. The playlist view owns its own scroll.
  const listMaxHeight = Math.max(actionRowHeight, menuMaxHeight - primaryRowHeight);
  const menuScrollable = listContentHeight > listMaxHeight + 0.5;
  const isDark = colorScheme === 'dark';
  const menuFadeColors = useMemo<readonly [string, string]>(() => {
    if (surfaceMode !== 'material') return isDark ? MENU_FADE_COLORS.dark : MENU_FADE_COLORS.light;
    const cardTone = m3SurfaceContainers[MENU_CARD_ROLE];
    return [withAlpha(cardTone, 0), withAlpha(cardTone, MENU_FADE_END_ALPHA)];
  }, [surfaceMode, isDark, m3SurfaceContainers]);
  // Same tone as the menu card, fully opaque — the board art backing reads as
  // the same surface instead of a separate theme color.
  const boardArtBackgroundColor = useMemo(() => {
    if (surfaceMode === 'material') return m3SurfaceContainers[MENU_CARD_ROLE];
    return isDark ? MENU_CARD_SOLID.dark : MENU_CARD_SOLID.light;
  }, [surfaceMode, isDark, m3SurfaceContainers]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const previewStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.9 + progress.value * 0.1 }],
  }));
  const menuStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 18 }, { scale: 0.96 + progress.value * 0.04 }],
  }));

  return (
    <OverlayPortal onRequestClose={handleRequestClose}>
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop, painted the same opaque tone as the menu card so the whole
            overlay reads as one surface. Tapping it pops the playlist view back
            to the menu first (matching the back button), and dismisses from the
            menu — so a stray tap can't tear down a half-typed create form. */}
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: boardArtBackgroundColor }]} />
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleRequestClose}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.climbActions.closeOverlay')}
          />
        </Animated.View>

        {/* Floating content: enlarged climb + action menu. box-none so empty space
            falls through to the backdrop Pressable. Plain View — the animated nodes
            are the inner preview and menu wrap. */}
        <View
          pointerEvents="box-none"
          // Contain VoiceOver focus to the floating content (don't let it wander into
          // the screen behind), and let the VO escape gesture pop the view / dismiss.
          accessibilityViewIsModal={Platform.OS === 'ios'}
          onAccessibilityEscape={handleRequestClose}
          style={[
            styles.content,
            { paddingTop: insets.top + contentTopOffset, paddingBottom: insets.bottom + spacing[5] },
          ]}
        >
          {/* The enlarged climb stays visible in both views — the playlist picker
              replaces the action list below it, not the climb itself. The menu/picker
              cap is derived from the target art size (reservedForPreview), not measured
              here, so the shrink animation never re-renders the menu. */}
          <Animated.View pointerEvents="box-none" style={[styles.preview, previewStyle]}>
            {/* Name · grade · byline sit ABOVE the board (like the play drawer header),
                so the board reads as the hero below its title. */}
            <View style={styles.previewText}>
              <View style={styles.nameRow}>
                <Text variant="headline" numberOfLines={1} style={styles.name}>
                  {climb.name}
                </Text>
                <ClimbAttributeIcons
                  benchmarkDifficulty={climb.benchmark_difficulty}
                  characteristics={climb.characteristics}
                />
                {formattedGrade || climb.difficulty ? (
                  <Text variant="headline" numberOfLines={1} style={[styles.grade, { color: gradeColor }]}>
                    {formattedGrade ?? climb.difficulty}
                  </Text>
                ) : null}
              </View>
              {byline ? (
                <Text variant="footnote" numberOfLines={1} style={styles.byline}>
                  {byline}
                </Text>
              ) : null}
            </View>
            {boardRenderData ? (
              <Animated.View style={[styles.art, { backgroundColor: boardArtBackgroundColor }, animatedArtStyle]}>
                <BoardImageNative
                  frames={climb.frames}
                  boardName={boardConfig.boardName as BoardName}
                  layoutId={boardConfig.layoutId}
                  sizeId={boardConfig.sizeId}
                  setIds={boardConfig.setIds}
                  boardWidth={boardRenderData.boardWidth}
                  boardHeight={boardRenderData.boardHeight}
                  mirrored={climb.mirrored === true}
                  renderWidth={overlayRenderWidth}
                  backgroundVariant="full"
                  style={styles.artFill}
                />
              </Animated.View>
            ) : null}
          </Animated.View>

          <Animated.View style={[styles.menuWrap, menuStyle]}>
            <GlassSurface role={MENU_CARD_ROLE} level="level3" borderRadius={borderRadius.xl} style={styles.menuCard}>
              {view === 'playlist' ? (
                // The picker pins its own header and scrolls the list within
                // menuMaxHeight, so "back" stays put however far you scroll.
                <InlinePlaylistPicker
                  climb={climb}
                  angle={boardConfig.angle}
                  boardName={boardConfig.boardName as BoardName}
                  layoutId={boardConfig.layoutId}
                  TextInputComponent={TextInput}
                  onBack={backToMenu}
                  maxHeight={menuMaxHeight}
                  onDetachedFailure={holdFailureUntilDismissed}
                />
              ) : (
                <View>
                  {/* Fixed quick-action row — the three most-reached actions as tappable
                      buttons, above the scrollable remainder. */}
                  {primaryActions.length > 0 ? (
                    <View style={styles.primaryRow} onLayout={handlePrimaryRowLayout}>
                      {primaryActions.map((action) => (
                        <PrimaryActionButton
                          key={action.id}
                          action={action}
                          fillColor={systemColors.fill}
                          labelColor={systemColors.label}
                        />
                      ))}
                    </View>
                  ) : null}
                  {/* The full list is reserved when sizing the board, so this normally
                      shows every row without scrolling; maxHeight only bites (and scrolls)
                      if a floored board on a small phone can't leave room. */}
                  <ScrollView
                    style={{ maxHeight: listMaxHeight }}
                    bounces={false}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.menuContent}
                  >
                    {/* Dividerless, like an M3 action list and an iOS context menu —
                        the rows already read as separate targets, and hairlines under
                        a scrolling list fight the bottom fade. Icons at 24 to match
                        the primary row above. */}
                    {listActions.map((action) => (
                      <ListRow
                        key={action.id}
                        title={action.title}
                        leading={<Icon name={action.icon} size={24} color={action.color} />}
                        onPress={action.run}
                        showSeparator={false}
                      />
                    ))}
                  </ScrollView>
                  {/* Bottom-edge fade cueing "more below" — only when the list is clipped.
                      pointerEvents none so it never eats a tap on the peeking row. */}
                  {menuScrollable ? (
                    <LinearGradient pointerEvents="none" colors={menuFadeColors} style={styles.menuScrollFade} />
                  ) : null}
                </View>
              )}
            </GlassSurface>
          </Animated.View>
        </View>
      </View>
    </OverlayPortal>
  );
}

type PrimaryActionButtonProps = {
  action: ClimbActionItem;
  /** Translucent control fill for the button surface (systemColors.fill). */
  fillColor: string | OpaqueColorValue;
  /** Label foreground (systemColors.label); the icon keeps the action's own colour. */
  labelColor: string | OpaqueColorValue;
};

// One quick-action button: the action's icon over its (up-to-2-line) label, on a
// translucent fill. `alignItems: 'stretch'` on the row makes every button match the
// tallest, so "Add to Playlist" wrapping to two lines keeps all three the same height.
function PrimaryActionButton({ action, fillColor, labelColor }: PrimaryActionButtonProps) {
  return (
    <Pressable
      onPress={action.run}
      accessibilityRole="button"
      accessibilityLabel={action.title}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: fillColor },
        pressed && styles.primaryButtonPressed,
      ]}
    >
      <Icon name={action.icon} size={24} color={action.color} />
      <Text variant="caption1" numberOfLines={2} style={[styles.primaryButtonLabel, { color: labelColor }]}>
        {action.title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    // Anchor from the top, not centered: the climb preview keeps a fixed position
    // whether the action list or the (shorter/taller) playlist picker sits below
    // it, so switching views never shifts the climb up or down.
    justifyContent: 'flex-start',
    paddingHorizontal: spacing[6],
    gap: spacing[5],
  },
  preview: {
    alignItems: 'center',
    gap: spacing[3],
    width: '100%',
    maxWidth: PREVIEW_MAX_WIDTH,
  },
  // The animating art wrapper — carries the rounded clip; its width/height are driven
  // by animatedArtStyle so the board render resizes between hero and compact sizes.
  // No backgroundColor here (added at the call site with boardArtBackgroundColor,
  // the menu card's own tone): LayeredClimbImage's board-photo layer paints
  // asynchronously and has no opaque backing of its own, so without one this
  // wrapper shows the blurred/scrim backdrop through it until the photo loads
  // (persistently on Android, which has no blur to hide the gap behind).
  art: {
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    padding: spacing[2],
  },
  // The board render fills the animating wrapper; explicit width+height override
  // BoardImageNative's internal aspectRatio (the wrapper already preserves aspect).
  artFill: {
    width: '100%',
    height: '100%',
  },
  previewText: {
    alignItems: 'center',
    gap: 2,
    width: '100%',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    width: '100%',
  },
  name: {
    fontWeight: '700',
    flexShrink: 1,
  },
  byline: {
    opacity: 0.6,
    textAlign: 'center',
  },
  grade: {
    fontWeight: '800',
  },
  menuWrap: {
    width: '100%',
    maxWidth: PREVIEW_MAX_WIDTH,
    alignSelf: 'center',
  },
  // The clip keeps the scrolling list, its bottom fade and the playlist picker's
  // pinned header inside the rounded corners. GlassSurface hoists it onto an inner
  // wrapper on Material so it can't clip the card's own elevation cast.
  menuCard: {
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
  },
  // Fixed quick-action row above the scrollable list. `stretch` keeps every button the
  // height of the tallest (the two-line "Add to Playlist").
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  primaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[1],
    borderRadius: borderRadius.lg,
  },
  primaryButtonPressed: {
    opacity: 0.6,
  },
  primaryButtonLabel: {
    fontWeight: '600',
    textAlign: 'center',
  },
  menuContent: {
    paddingVertical: spacing[1],
  },
  menuScrollFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 48,
  },
});
