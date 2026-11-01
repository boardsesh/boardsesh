import { memo, useCallback, type ReactNode } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { Climb } from '@boardsesh/queue';
import type { MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useFavoriteStatus, useToggleFavorite } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { trackQueueSheetOpened } from '../../lib/queue-navigation-analytics';
import { useShareClimbAction } from '../../hooks/use-share-climb-action';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { opacity } from '../../theme/tokens';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { AnglePill } from '../play-drawer/AnglePill';
import { useRouter, useSegments } from 'expo-router';
import { WALL_DISPLAY_HREF } from '../../lib/routing/wall-display-link';
import { isPlayerRoute } from '../../lib/route-segments';
import { MiniPlayerTrackPager, useMiniPlayerNavigation } from './use-mini-player-navigation';
import { useQueueActions } from '../../providers/queue-provider';

type MiniPlayerIconButtonProps = {
  iconName: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  /** A toggle that is on (Mirror): VoiceOver says "selected". */
  selected?: boolean;
  size: number;
  iconColor?: ColorValue;
  /** The glyph's point size. The iPhone bar draws every control at 22pt. */
  iconSize?: number;
};

/**
 * The glyphs on a wide bar (Music's iPad layout): ⏮ ⏭ filled and a size up,
 * the climber's other buttons a size down in the secondary label colour, so
 * the transport and ✓ carry the bar.
 */
export const WIDE_TRANSPORT_GLYPH_SIZE = 24;
export const WIDE_SECONDARY_GLYPH_SIZE = 19;
const PHONE_GLYPH_SIZE = 22;

/** A borderless platter control, drawn like the tick beside it: UIKit supplies the glass. */
function MiniPlayerIconButton({
  iconName,
  accessibilityLabel,
  onPress,
  disabled = false,
  selected,
  size,
  iconColor,
  iconSize = PHONE_GLYPH_SIZE,
}: MiniPlayerIconButtonProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      style={[styles.action, { width: size, height: size }, disabled ? styles.disabled : null]}
    >
      <Icon maxFontSizeMultiplier={1} name={iconName} size={iconSize} color={iconColor ?? systemColors.label} />
    </PressableSurface>
  );
}

type ClimbButtonProps = {
  climb: Climb;
  /** The board the climb is drawn on, as the player resolves it. Its angle keys the favourite. */
  climbBoard: BoardConfig;
  size: number;
  /** Music's iPad layout: a smaller glyph in the secondary label colour. */
  wideLayout: boolean;
};

/**
 * The MiniPlayer's heart: its state and its toggle. It reads and writes the same
 * `favoriteStatus` cache entry as the player's heart (`useToggleFavorite` flips
 * it optimistically), so the two agree even side by side on the open Duo. The
 * bar's button and the bar's ⋯ row both run this, so they never disagree.
 */
export function useMiniPlayerFavorite({
  climb,
  climbBoard,
  bluetoothConnected,
  source,
  enabled = true,
}: {
  climb: Climb;
  climbBoard: BoardConfig;
  bluetoothConnected: boolean;
  /** `FavoriteToggle`'s `source`: the bar's button or its ⋯ menu. */
  source: 'mini_player' | 'mini_player_menu';
  /** False fetches nothing (a ⋯ with no Favorite row); a cached answer still reads. */
  enabled?: boolean;
}): { isFavorited: boolean; toggle: () => void } {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { boardName, layoutId, angle } = climbBoard;
  const { data: serverFavorited } = useFavoriteStatus(boardName, climb.uuid, angle, { enabled });
  const { mutate: toggleFavorite } = useToggleFavorite();
  const isFavorited = serverFavorited ?? false;
  const toggle = useCallback(() => {
    hapticSelection();
    toggleFavorite(
      {
        input: { boardName, climbUuid: climb.uuid, angle },
        currentlyFavorited: isFavorited,
        tracking: { source, layoutId, connected: bluetoothConnected },
      },
      { onError: () => showToast(t('playView.favoriteError'), 'error') },
    );
  }, [isFavorited, climb.uuid, boardName, layoutId, angle, bluetoothConnected, source, toggleFavorite, showToast, t]);
  return { isFavorited, toggle };
}

/** The heart on the bar. */
function MiniPlayerFavoriteButton({
  climb,
  climbBoard,
  size,
  wideLayout,
  bluetoothConnected,
}: ClimbButtonProps & { bluetoothConnected: boolean }) {
  const { t } = useTranslation('session');
  const { actionColors, systemColors } = useTheme();
  const { isFavorited, toggle: handlePress } = useMiniPlayerFavorite({
    climb,
    climbBoard,
    bluetoothConnected,
    source: 'mini_player',
  });
  return (
    <MiniPlayerIconButton
      iconName={isFavorited ? 'favorite.fill' : 'favorite'}
      iconColor={isFavorited ? actionColors.favoriteSelected : wideLayout ? systemColors.secondaryLabel : undefined}
      iconSize={wideLayout ? WIDE_SECONDARY_GLYPH_SIZE : undefined}
      accessibilityLabel={
        isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
      }
      onPress={handlePress}
      size={size}
    />
  );
}

/** Share, through the same tap (and tracking) as the player's share button. */
function MiniPlayerShareButton({ climb, climbBoard, size, wideLayout }: ClimbButtonProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const handleShare = useShareClimbAction({
    // The queue's climb is the shared-schema climb the player shares.
    climb,
    boardName: climbBoard.boardName,
    layoutId: climbBoard.layoutId,
    sizeId: climbBoard.sizeId,
    setIds: climbBoard.setIds,
    angle: climbBoard.angle,
    source: 'mini_player',
  });
  return (
    <MiniPlayerIconButton
      iconName="share"
      accessibilityLabel={t('mobile.climbRow.share')}
      onPress={handleShare}
      size={size}
      iconSize={wideLayout ? WIDE_SECONDARY_GLYPH_SIZE : undefined}
      iconColor={wideLayout ? systemColors.secondaryLabel : undefined}
    />
  );
}

/**
 * Mirror the exact committed occurrence shown by this retained accessory. The
 * bar's button and the bar's ⋯ row both run this toggle.
 */
export function useMiniPlayerMirrorToggle({
  climb,
  climbBoard,
  queueItemUuid,
}: {
  climb: Climb;
  climbBoard: BoardConfig;
  queueItemUuid?: string;
}): { isMirrored: boolean; toggle: () => void } {
  const { mirrorCurrentClimb, getQueueSnapshot } = useQueueActions();
  const isMirrored = climb.mirrored === true;
  const toggle = useCallback(() => {
    const snapshot = getQueueSnapshot();
    const headItem = snapshot.currentClimbQueueItem;
    if (!queueItemUuid || headItem?.uuid !== queueItemUuid || headItem.climb.uuid !== climb.uuid) return;
    const shared = snapshot.sessionId != null;
    if (
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
      process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS?.includes('screenshotClimbId=') === true &&
      shared
    )
      return;
    const mirrored = !(headItem.climb.mirrored === true);
    hapticSelection();
    track(SHARED_EVENTS.MirrorClimb, {
      climbUuid: climb.uuid,
      boardName: climbBoard.boardName,
      layoutId: climbBoard.layoutId,
      isMirrored: mirrored,
      surface: 'mini_player',
      shared,
    });
    void mirrorCurrentClimb(mirrored, headItem.uuid);
  }, [getQueueSnapshot, queueItemUuid, climb.uuid, climbBoard, mirrorCurrentClimb]);
  return { isMirrored, toggle };
}

function MiniPlayerMirrorButton({
  climb,
  climbBoard,
  size,
  wideLayout,
  queueItemUuid,
}: ClimbButtonProps & { queueItemUuid?: string }) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();
  const { isMirrored, toggle: handlePress } = useMiniPlayerMirrorToggle({ climb, climbBoard, queueItemUuid });
  return (
    <MiniPlayerIconButton
      iconName="mirror"
      iconColor={isMirrored ? brandColors.primary : wideLayout ? systemColors.secondaryLabel : undefined}
      iconSize={wideLayout ? WIDE_SECONDARY_GLYPH_SIZE : undefined}
      selected={isMirrored}
      accessibilityLabel={isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')}
      onPress={handlePress}
      size={size}
    />
  );
}

/** Open the queue sheet from the bar: its Queue button or its ⋯ row. */
export function useOpenMiniPlayerQueue(surface: 'mini_player' | 'mini_player_menu'): () => void {
  const { openQueueSheet, boardConfig } = useDrawerHost();
  const boardType = boardConfig?.boardName;
  return useCallback(() => {
    trackQueueSheetOpened({ surface, boardType });
    openQueueSheet();
  }, [openQueueSheet, boardType, surface]);
}

function MiniPlayerQueueButton({ size, wideLayout }: { size: number; wideLayout: boolean }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const handlePress = useOpenMiniPlayerQueue('mini_player');
  return (
    <MiniPlayerIconButton
      iconName="queue"
      accessibilityLabel={t('mobile.queueSnackbar.openAria')}
      onPress={handlePress}
      size={size}
      iconSize={wideLayout ? WIDE_SECONDARY_GLYPH_SIZE : undefined}
      iconColor={wideLayout ? systemColors.secondaryLabel : undefined}
    />
  );
}

/**
 * The player's angle pill and sheet: the same angle the player shows, changed
 * through the player's own handler (the drawer host's), so the crew follows and
 * a foreign climb's board takes it, as from the player.
 */
function MiniPlayerAngleButton({ angle, climbUuid }: { angle: number; climbUuid: string | undefined }) {
  const { t } = useTranslation('session');
  const { openAnglePicker } = useDrawerHost();
  const handlePress = useCallback(() => openAnglePicker(climbUuid), [openAnglePicker, climbUuid]);
  return (
    <AnglePill
      compact
      angle={angle}
      onPress={handlePress}
      accessibilityLabel={t('mobile.angleSelector.buttonAria', { angle })}
    />
  );
}

/**
 * ⛶ on a tablet's bar: the full-screen Wall display, the same push as the board
 * sheet's `WallDisplayEntry`. Drawn after ⋯ like Music's lyrics button, at the
 * bulb's 22pt in the label colour.
 */
export const MiniPlayerWallDisplayButton = memo(function MiniPlayerWallDisplayButton({ size }: { size: number }) {
  const { t } = useTranslation('session');
  const router = useRouter();
  const handlePress = useCallback(() => router.push(WALL_DISPLAY_HREF), [router]);
  return (
    <View testID="mini-player-slot-wallDisplay">
      <MiniPlayerIconButton
        iconName="expand"
        accessibilityLabel={t('mobile.boardPresence.wallDisplay.open')}
        onPress={handlePress}
        size={size}
        iconSize={PHONE_GLYPH_SIZE}
      />
    </View>
  );
});

/** ⏮ ⏭: their targets are walked only while one of them is on the bar. */
function MiniPlayerTransportButtons({
  buttonIds,
  renderSlot,
  size,
  wideLayout,
}: {
  buttonIds: readonly MiniPlayerButtonId[];
  renderSlot: (buttonId: MiniPlayerButtonId, button: ReactNode) => ReactNode;
  size: number;
  wideLayout: boolean;
}) {
  const { t } = useTranslation('session');
  const navigation = useMiniPlayerNavigation();
  // The host stays mounted under the player, which pages its own track.
  const segments = useSegments();
  const playerOpen = isPlayerRoute(segments);
  return (
    <>
      {buttonIds.includes('next') && !playerOpen ? <MiniPlayerTrackPager /> : null}
      {buttonIds.map((buttonId) =>
        renderSlot(
          buttonId,
          buttonId === 'previous' ? (
            <MiniPlayerIconButton
              iconName={wideLayout ? 'skip.previous.fill' : 'skip.previous'}
              accessibilityLabel={t('playView.actionBar.previousAria')}
              onPress={navigation.onPrevious}
              disabled={!navigation.canPrevious}
              size={size}
              iconSize={wideLayout ? WIDE_TRANSPORT_GLYPH_SIZE : undefined}
            />
          ) : (
            <MiniPlayerIconButton
              iconName={wideLayout ? 'skip.next.fill' : 'skip.next'}
              accessibilityLabel={t('playView.actionBar.nextAria')}
              onPress={navigation.onNext}
              disabled={!navigation.canNext}
              size={size}
              iconSize={wideLayout ? WIDE_TRANSPORT_GLYPH_SIZE : undefined}
            />
          ),
        ),
      )}
    </>
  );
}

const TRANSPORT: ReadonlySet<MiniPlayerButtonId> = new Set(['previous', 'next']);

type MiniPlayerLeadingButtonsProps = {
  queueItemUuid?: string;
  /** Left to right, as `resolveMiniPlayerControls` placed them. */
  buttonIds: readonly MiniPlayerButtonId[];
  climb: Climb;
  /** The board the climb is drawn on. `null` while no board is resolved: the climb's own buttons wait for one. */
  climbBoard: BoardConfig | null;
  /** The angle the player's pill shows, `null` on a fixed-angle board (`resolvePlayerAngle`). */
  angle: number | null;
  /** The climb whose grades the angle sheet shows per angle, when it is drawn on the player's board. */
  angleClimbUuid: string | undefined;
  /** This phone holds the board's link: tags the heart's FavoriteToggle, as the player's does. */
  bluetoothConnected: boolean;
  slotWidth: number;
  rowHeight: number;
  /**
   * Music's iPad layout (`miniPlayerUsesWideLayout`): ⏮ ⏭ filled and first, the
   * others smaller in the secondary label colour. The ids already arrive in
   * that order.
   */
  wideLayout: boolean;
};

/**
 * The MiniPlayer's buttons before Board light and Log (#6940). Each sits in a
 * slot keyed by its id, so a change of buttons swaps slots inside the live row
 * and the row itself never remounts (UIKit snapshots the platter). Each button
 * reads only what it draws, so a heart's query never mounts for a climber who
 * keeps the heart off.
 */
export const MiniPlayerLeadingButtons = memo(function MiniPlayerLeadingButtons({
  buttonIds,
  climb,
  queueItemUuid,
  climbBoard,
  angle,
  angleClimbUuid,
  bluetoothConnected,
  slotWidth,
  rowHeight,
  wideLayout,
}: MiniPlayerLeadingButtonsProps) {
  const others = buttonIds.filter((buttonId) => !TRANSPORT.has(buttonId));
  const transport = buttonIds.filter((buttonId) => TRANSPORT.has(buttonId));

  const renderSlot = (buttonId: MiniPlayerButtonId, button: ReactNode) => (
    <View
      key={buttonId}
      testID={`mini-player-slot-${buttonId}`}
      style={[styles.slot, { width: slotWidth, height: rowHeight }]}
    >
      {button}
    </View>
  );

  const renderButton = (buttonId: MiniPlayerButtonId) => {
    switch (buttonId) {
      case 'favorite':
        return climbBoard ? (
          <MiniPlayerFavoriteButton
            climb={climb}
            climbBoard={climbBoard}
            size={slotWidth}
            wideLayout={wideLayout}
            bluetoothConnected={bluetoothConnected}
          />
        ) : null;
      case 'share':
        return climbBoard ? (
          <MiniPlayerShareButton climb={climb} climbBoard={climbBoard} size={slotWidth} wideLayout={wideLayout} />
        ) : null;
      case 'queue':
        return <MiniPlayerQueueButton size={slotWidth} wideLayout={wideLayout} />;
      case 'angle':
        return angle !== null ? <MiniPlayerAngleButton angle={angle} climbUuid={angleClimbUuid} /> : null;
      case 'mirror':
        return climbBoard ? (
          <MiniPlayerMirrorButton
            queueItemUuid={queueItemUuid}
            climb={climb}
            climbBoard={climbBoard}
            size={slotWidth}
            wideLayout={wideLayout}
          />
        ) : null;
      // ⏮ ⏭ render below.
      default:
        return null;
    }
  };

  // The resolver keeps ⏮ ⏭ together: first on a wide bar, last elsewhere.
  const transportButtons =
    transport.length > 0 ? (
      <MiniPlayerTransportButtons
        buttonIds={transport}
        renderSlot={renderSlot}
        size={slotWidth}
        wideLayout={wideLayout}
      />
    ) : null;
  return (
    <>
      {wideLayout ? transportButtons : null}
      {others.map((buttonId) => renderSlot(buttonId, renderButton(buttonId)))}
      {wideLayout ? null : transportButtons}
    </>
  );
});

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: opacity.disabled,
  },
});
