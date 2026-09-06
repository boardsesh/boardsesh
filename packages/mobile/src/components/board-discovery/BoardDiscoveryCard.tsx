import { memo, useCallback, useMemo } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Platform,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticHeavy, hapticLight } from '../../lib/haptics';
import { ACTIVATE_ACCESSIBILITY_ACTIONS, rowAccessibilityActionsWith } from '../../lib/row-accessibility-actions';
import { springs } from '../../theme/animations';
import { spacing, borderRadius, overlays } from '../../theme/tokens';
import { textStyles, CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { iosSystemColors } from '../../theme/ios-colors';
import { withAlpha } from '../../theme/colors';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { BoardImageNative } from '../BoardImageNative';
import type { BoardCardAction } from './board-card-actions';
import type { BoardDownloadState } from './board-offline-state';

/** The minimal board shape the card renders. UserBoard, PopularBoardConfig, and
 *  BLE-resolved boards all map onto this so one card serves every section. */
export type DiscoveryBoardItem = {
  /** Stable key for the list. */
  key: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids (the UserBoard wire shape). */
  setIds: string;
  title: string;
  subtitle?: string | null;
  /** When set, renders the distance badge (metres from the user). */
  distanceMeters?: number | null;
  /** When true, marks this as the currently-active board. */
  isActive?: boolean;
  /**
   * Whether the signed-in user owns this board, stamped once per list build by
   * `userBoardToItem`. `undefined` means "not resolvable here" — Near you /
   * Popular, or a session with no identity — and suppresses the ownership badge
   * entirely rather than guessing (offering to unfollow the user's own wall is
   * worse than offering nothing).
   */
  isViewerOwner?: boolean;
  /**
   * Whether the viewer pinned this board to the front of their list. Only the
   * "Your boards" carousel renders a control for it; elsewhere it is unset and
   * the slot stays empty.
   */
  isPinned?: boolean;
  /**
   * Offline download state for this board's scope. Absent on cards that cannot
   * be downloaded as a board (popular configs — see `popularConfigToItem`).
   */
  offlineState?: BoardDownloadState;
};

export const DISCOVERY_CARD_WIDTH = 168;

/**
 * Lines the board name gets. Board names routinely run past a 168pt card
 * ("Bergen Klatresenter Danmarksplass"), and one line ellipsised two boards at
 * the same gym into the same string. The title box reserves all of them so a
 * one-line card and a two-line card keep their subtitles on the same baseline
 * across the row.
 */
const TITLE_LINES = 2;

/**
 * Corner badge diameter, and the hitSlop that lifts it to the 44pt tap floor.
 * The inset matches the hitSlop on purpose: Android clips a child's hitSlop to
 * its parent's bounds, and these discs live inside `thumb` (which has
 * `overflow: 'hidden'`), so an 8pt inset would clamp the rect to 43pt. At 9 the
 * 44pt square starts exactly on the thumb's edge and survives on both platforms.
 */
const CORNER_BADGE_SIZE = 26;
const CORNER_BADGE_HIT_SLOP = 9;
const CORNER_BADGE_INSET = CORNER_BADGE_HIT_SLOP;

/** Custom accessibility action names for the card's nested buttons. */
const BOARD_ACTION_NAME = 'boardAction';
const DOWNLOAD_ACTION_NAME = 'download';
const PIN_ACTION_NAME = 'pin';

/** Distance badge copy: metres under 1km, one-decimal km above. */
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BoardDiscoveryCardProps = {
  item: DiscoveryBoardItem;
  onPress: (item: DiscoveryBoardItem) => void;
  /**
   * Offer a one-tap download for an un-downloaded board. Passed only by the
   * carousel that renders boards the user owns or follows; Nearby (other
   * people's boards), Popular (no uuid) and the offline rows (already on the
   * device, and there is no connection) never get one.
   */
  onDownload?: (item: DiscoveryBoardItem) => void;
  /** Accessibility label for the download glyph. */
  downloadLabel?: string;
  /**
   * The board-ownership action this card offers: edit your own board, or stop
   * following someone else's. `null`/absent renders no slot at all — Near you,
   * Popular, the offline branch, and any card whose ownership did not resolve.
   */
  action?: BoardCardAction;
  onAction?: (item: DiscoveryBoardItem) => void;
  /** Screen-reader label for the action (editAria / unfollowAria / deleteAria). */
  actionLabel?: string;
  /** Visible label for the Edit-mode footer button ("Delete" / "Unfollow"). */
  actionTitle?: string;
  /**
   * The "Your boards" section is in Edit mode: the corner badge is replaced by a
   * labelled destructive button under the subtitle, and the card body stops
   * activating the board. The label is the point — an unlabelled red glyph on an
   * ungrouped carousel cannot say whether it deletes a wall or unfollows a gym.
   */
  isEditing?: boolean;
  /** A delete/unfollow targeting THIS card is in flight. */
  isActionPending?: boolean;
  /**
   * Toggle this board's pin. Passed only by the "Your boards" carousel — every
   * other surface omits it, which is what suppresses the control entirely
   * (Near you, Popular, onboarding, and the offline branch, where the mutation
   * could not reach the server anyway).
   */
  onTogglePin?: (item: DiscoveryBoardItem) => void;
  /** Screen-reader label for the pin toggle (pinAria / unpinAria). */
  pinLabel?: string;
};

/**
 * One board in a carousel. Memoized: three carousels stacked on the Boards tab
 * re-render together whenever any of their queries settle, and each card resolves
 * board art. `isEditing` and `isActionPending` are scalars and the handlers are
 * host-memoized, so a mutation starting re-renders the carousel but flips
 * `isActionPending` on the one card that owns it.
 */
export const BoardDiscoveryCard = memo(function BoardDiscoveryCard({
  item,
  onPress,
  onDownload,
  downloadLabel,
  action = null,
  onAction,
  actionLabel,
  actionTitle,
  isEditing = false,
  isActionPending = false,
  onTogglePin,
  pinLabel,
}: BoardDiscoveryCardProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, radii } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const render = useMemo(
    () =>
      getBoardRenderData({
        boardName: item.boardName,
        layoutId: item.layoutId,
        sizeId: item.sizeId,
        setIds: item.setIds.split(',').map(Number).filter(Number.isFinite),
      }),
    [item.boardName, item.layoutId, item.sizeId, item.setIds],
  );

  const thumbStyle = {
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: item.isActive ? brandColors.primary : systemColors.separator,
    borderWidth: item.isActive ? 2 : StyleSheet.hairlineWidth,
  };

  // Resting, a pencil on your own board: a navigation, safe to fire from a corner
  // glyph. Resting, a board you follow gets a NON-INTERACTIVE person-with-check —
  // unfollow is destructive and unconfirmed, and a 26pt disc that reads like the
  // download-status badge on the opposite corner must never remove a board in one
  // tap. Unfollowing lives on Edit mode's labelled footer button instead, so the
  // resting surface carries no destructive control at all.
  const showEditBadge = !isEditing && action === 'edit' && onAction !== undefined;
  const showFollowingBadge = !isEditing && action === 'unfollow';
  const showEditAction = isEditing && (action === 'delete' || action === 'unfollow') && onAction !== undefined;
  const canDownload = item.offlineState === 'off' && onDownload !== undefined;
  // Mirrors the render guard below, so the rotor never publishes an action the
  // touch surface does not offer.
  const canPin = onTogglePin !== undefined && item.distanceMeters == null;

  const handleAction = useCallback(() => {
    onAction?.(item);
  }, [onAction, item]);

  const handleEditAction = useCallback(() => {
    if (isActionPending) return;
    hapticHeavy();
    onAction?.(item);
  }, [isActionPending, onAction, item]);

  const handleDownload = useCallback(() => {
    hapticLight();
    onDownload?.(item);
  }, [onDownload, item]);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(item);
  }, [onPress, item]);

  const handleTogglePin = useCallback(() => {
    hapticLight();
    onTogglePin?.(item);
  }, [onTogglePin, item]);

  // The outer Pressable sets `accessible` by default, so on iOS UIKit treats the
  // card as a leaf and VoiceOver never reaches the corner glyphs. Publish each
  // nested button as a labelled custom action instead — the same shape
  // ClimbListRow uses for its ⋮ button. Keyed on the resolved label strings,
  // never on `t`, whose identity churns on plenty of renders.
  // The following indicator is status, not an action, so it publishes nothing.
  const hasBoardAction = showEditBadge || showEditAction;
  const accessibilityActions = useMemo(() => {
    const nested: AccessibilityActionInfo[] = [];
    if (hasBoardAction && actionLabel !== undefined) nested.push({ name: BOARD_ACTION_NAME, label: actionLabel });
    if (canDownload && downloadLabel !== undefined) nested.push({ name: DOWNLOAD_ACTION_NAME, label: downloadLabel });
    if (canPin && pinLabel !== undefined) nested.push({ name: PIN_ACTION_NAME, label: pinLabel });
    return nested.length > 0 ? rowAccessibilityActionsWith(...nested) : ACTIVATE_ACCESSIBILITY_ACTIONS;
  }, [hasBoardAction, actionLabel, canDownload, downloadLabel, canPin, pinLabel]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      if (actionName === 'activate' && !isEditing) handlePress();
      // Route to the same handler the touch path uses, so the destructive button
      // keeps its haptic when it is reached from the rotor.
      if (actionName === BOARD_ACTION_NAME) (showEditAction ? handleEditAction : handleAction)();
      if (actionName === DOWNLOAD_ACTION_NAME) handleDownload();
      if (actionName === PIN_ACTION_NAME) handleTogglePin();
    },
    [isEditing, showEditAction, handlePress, handleAction, handleEditAction, handleDownload, handleTogglePin],
  );

  const activeLabel = t('mobile.discovery.activeBadge');
  // Once the owned/followed grouping is gone from this surface the corner glyph
  // is the ONLY owned-vs-followed signal, so the composed label has to carry it —
  // otherwise a screen-reader user cannot tell which board the custom action
  // removes.
  const ownershipLabel =
    item.isViewerOwner === undefined
      ? null
      : item.isViewerOwner
        ? t('mobile.discovery.ownedBadgeAria')
        : t('mobile.discovery.followingBadgeAria');
  const pinnedLabel = canPin && item.isPinned ? t('mobile.discovery.pinnedBadgeAria') : null;
  const accessibilityLabel = [
    item.title,
    item.subtitle,
    item.isActive ? activeLabel : null,
    ownershipLabel,
    pinnedLabel,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      // In Edit mode the body is not a target: dropping the role as well as the
      // handler is what makes the card visibly (and audibly) stop being tappable.
      disabled={isEditing}
      accessibilityRole={isEditing ? undefined : 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      style={[animatedStyle, styles.container]}
    >
      <View testID="board-card" style={[styles.thumb, thumbStyle]}>
        {render ? (
          <BoardImageNative
            frames=""
            boardName={item.boardName}
            layoutId={item.layoutId}
            sizeId={item.sizeId}
            setIds={item.setIds}
            boardWidth={render.boardWidth}
            boardHeight={render.boardHeight}
            // Resolve the thumb-sized (416px) background + a 400px overlay
            // instead of the full-res native webp (up to ~1461px). A 168px cell
            // doesn't need the native source, and decoding it on the main thread
            // for every card in three stacked carousels stutters / hangs the
            // picker. Matches ClimbListThumbnail's renderWidth so the thumb
            // background and overlay cache entries are shared across surfaces.
            renderWidth={400}
            style={styles.boardImage}
          />
        ) : (
          <View style={styles.thumbFallback}>
            <Icon name="boards" size={36} color={systemColors.tertiaryLabel} />
          </View>
        )}

        {/* At-a-glance "is this board on my phone". A downloaded or in-flight
            board is a status badge with no press target; only 'off' is
            actionable, and only where the host passed a handler. */}
        {item.offlineState === 'downloaded' ? (
          <View style={styles.offlineBadge}>
            <Icon name="offline.downloaded" size={15} color={brandColors.primaryFill} />
          </View>
        ) : item.offlineState === 'downloading' ||
          item.offlineState === 'finalizing' ||
          item.offlineState === 'pending' ? (
          <View style={styles.offlineBadge}>
            <Icon name="offline.pending" size={15} color={systemColors.secondaryLabel} />
          </View>
        ) : canDownload ? (
          <Pressable
            onPress={handleDownload}
            accessibilityRole="button"
            accessibilityLabel={downloadLabel}
            style={styles.offlineBadge}
            // The glyph is a 26pt disc inside a 168pt card, so widen the touch
            // area rather than the visual: 26 + 2 × 9 lands exactly on the 44pt
            // floor. The two corner rects sit 82pt apart and never overlap.
            hitSlop={CORNER_BADGE_HIT_SLOP}
          >
            <Icon name="offline.download" size={15} color={brandColors.primaryFill} />
          </Pressable>
        ) : null}

        {showEditBadge ? (
          <Pressable
            onPress={handleAction}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={styles.actionBadge}
            hitSlop={CORNER_BADGE_HIT_SLOP}
          >
            <Icon name="edit" size={15} color={brandColors.primaryFill} />
          </Pressable>
        ) : showFollowingBadge ? (
          // No press target and no accessibility props of its own: the composed
          // card label already announces "Following".
          <View style={styles.actionBadge}>
            <Icon name="person.check" size={15} color={brandColors.primaryFill} />
          </View>
        ) : null}

        {/* "This is the board you're on" is the most important state on the card,
            so it reads as a word rather than a bare tick — and it sits opposite
            the distance pill, which an active Near-you board also carries. */}
        {item.isActive ? (
          <View style={styles.activeBadge}>
            <Icon name="tick" size={11} color={overlays.onScrim} />
            <Text
              variant="caption2"
              color={overlays.onScrim}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            >
              {activeLabel}
            </Text>
          </View>
        ) : null}

        {/* The pin lives in the distance pill's slot. A board can't be both a
            proximity result and one of yours to pin, but guard anyway so the two
            can never stack. */}
        {onTogglePin && item.distanceMeters == null ? (
          <Pressable
            onPress={handleTogglePin}
            accessibilityRole="button"
            accessibilityState={{ selected: item.isPinned === true }}
            accessibilityLabel={pinLabel}
            style={styles.pinBadge}
            hitSlop={CORNER_BADGE_HIT_SLOP}
          >
            <Icon
              name={item.isPinned ? 'pin.fill' : 'pin'}
              size={13}
              color={item.isPinned ? brandColors.primaryFill : overlays.onScrim}
            />
          </Pressable>
        ) : null}

        {item.distanceMeters != null ? (
          <View style={styles.distanceBadge}>
            <Icon name="location" size={11} color={overlays.onScrim} />
            <Text
              variant="caption2"
              color={overlays.onScrim}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            >
              {formatDistance(item.distanceMeters)}
            </Text>
          </View>
        ) : null}
      </View>

      <Text variant="subheadline" numberOfLines={TITLE_LINES} style={styles.title}>
        {item.title}
      </Text>
      {item.subtitle ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {item.subtitle}
        </Text>
      ) : null}

      {showEditAction ? (
        <PressableSurface
          onPress={handleEditAction}
          disabled={isActionPending}
          scaleTo={0.97}
          rippleColor={brandColors.error}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={[
            styles.editAction,
            { backgroundColor: withAlpha(brandColors.error, 0.12), borderRadius: radii.button },
          ]}
        >
          {isActionPending ? (
            <ActivityIndicator size="small" color={brandColors.error} />
          ) : (
            <>
              <Icon name="minus.circle" size={16} color={brandColors.error} />
              <Text
                variant="subheadline"
                color={brandColors.error}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.editActionLabel}
              >
                {actionTitle}
              </Text>
            </>
          )}
        </PressableSurface>
      ) : null}
    </AnimatedPressable>
  );
});

// Shared geometry for the two top-corner discs and the two bottom overlay pills.
// Only the horizontal edge differs, so the corner budget stays literally two
// circles and two pills — never four circles, never a destructive one.
//
// The bottom-right pill is shared, not duplicated: it carries the distance on
// Near you and the pin toggle in "Your boards" (#4884). Those two never coexist
// — `distanceMeters` is only set by proximity queries, and the pin control is
// only handed to the saved-boards carousel — and the card asserts it by
// rendering the pin solely when distance is absent.
const cornerBadge = {
  position: 'absolute',
  top: CORNER_BADGE_INSET,
  width: CORNER_BADGE_SIZE,
  height: CORNER_BADGE_SIZE,
  borderRadius: borderRadius.full,
  backgroundColor: iosSystemColors.white,
  alignItems: 'center',
  justifyContent: 'center',
  ...Platform.select({
    ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2 },
    android: { elevation: 2 },
  }),
} as const;

const overlayPill = {
  position: 'absolute',
  bottom: spacing[2],
  flexDirection: 'row',
  alignItems: 'center',
  gap: 2,
  paddingHorizontal: spacing[2],
  paddingVertical: 2,
  borderRadius: borderRadius.full,
  backgroundColor: overlays.scrim,
} as const;

const styles = StyleSheet.create({
  container: {
    width: DISCOVERY_CARD_WIDTH,
  },
  thumb: {
    width: DISCOVERY_CARD_WIDTH,
    height: DISCOVERY_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[2],
  },
  boardImage: {
    width: '100%',
    height: '100%',
  },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineBadge: {
    ...cornerBadge,
    left: CORNER_BADGE_INSET,
  },
  actionBadge: {
    ...cornerBadge,
    right: CORNER_BADGE_INSET,
  },
  activeBadge: {
    ...overlayPill,
    left: spacing[2],
  },
  distanceBadge: {
    ...overlayPill,
    right: spacing[2],
  },
  // Shares the distance pill's slot and its exact geometry — the two never
  // appear together, so they should read as the same object in the same place.
  pinBadge: {
    ...overlayPill,
    right: spacing[2],
  },
  title: {
    fontWeight: '600',
    // Both type scales (HIG and Material) give subheadline the same lineHeight,
    // so one read covers both UI variants — see textStylesByVariant.
    minHeight: TITLE_LINES * textStyles.subheadline.lineHeight,
  },
  editAction: {
    height: 44,
    marginTop: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  editActionLabel: {
    fontWeight: '600',
    // RN row children default to flexShrink: 0, so a label wider than the box
    // overflows instead of ellipsising. German "Nicht mehr folgen" runs ~158dp at
    // the 1.2 cap against 148dp of usable width.
    flexShrink: 1,
  },
});
