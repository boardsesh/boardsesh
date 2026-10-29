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
import { useSegments } from 'expo-router';
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
};

/** A borderless platter control, drawn like the tick beside it: UIKit supplies the glass. */
function MiniPlayerIconButton({
  iconName,
  accessibilityLabel,
  onPress,
  disabled = false,
  selected,
  size,
  iconColor,
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
      <Icon maxFontSizeMultiplier={1} name={iconName} size={22} color={iconColor ?? systemColors.label} />
    </PressableSurface>
  );
}

type ClimbButtonProps = {
  climb: Climb;
  /** The board the climb is drawn on, as the player resolves it. Its angle keys the favourite. */
  climbBoard: BoardConfig;
  size: number;
};

/**
 * The heart. It reads and writes the same `favoriteStatus` cache entry as the
 * player's heart (`useToggleFavorite` flips it optimistically), so the two agree
 * even side by side on the open Duo.
 */
function MiniPlayerFavoriteButton({
  climb,
  climbBoard,
  size,
  bluetoothConnected,
}: ClimbButtonProps & { bluetoothConnected: boolean }) {
  const { t } = useTranslation('session');
  const { actionColors } = useTheme();
  const { showToast } = useToast();
  const { boardName, layoutId, angle } = climbBoard;
  const { data: serverFavorited } = useFavoriteStatus(boardName, climb.uuid, angle);
  const { mutate: toggleFavorite } = useToggleFavorite();
  const isFavorited = serverFavorited ?? false;
  const handlePress = useCallback(() => {
    hapticSelection();
    toggleFavorite(
      {
        input: { boardName, climbUuid: climb.uuid, angle },
        currentlyFavorited: isFavorited,
        tracking: { source: 'mini_player', layoutId, connected: bluetoothConnected },
      },
      { onError: () => showToast(t('playView.favoriteError'), 'error') },
    );
  }, [isFavorited, climb.uuid, boardName, layoutId, angle, bluetoothConnected, toggleFavorite, showToast, t]);
  return (
    <MiniPlayerIconButton
      iconName={isFavorited ? 'favorite.fill' : 'favorite'}
      iconColor={isFavorited ? actionColors.favoriteSelected : undefined}
      accessibilityLabel={
        isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
      }
      onPress={handlePress}
      size={size}
    />
  );
}

/** Share, through the same tap (and tracking) as the player's share button. */
function MiniPlayerShareButton({ climb, climbBoard, size }: ClimbButtonProps) {
  const { t } = useTranslation('climbs');
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
    />
  );
}

/** Mirror the exact committed occurrence shown by this retained accessory. */
function MiniPlayerMirrorButton({
  climb,
  climbBoard,
  size,
  queueItemUuid,
}: ClimbButtonProps & { queueItemUuid?: string }) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const { mirrorCurrentClimb, getQueueSnapshot } = useQueueActions();
  const isMirrored = climb.mirrored === true;
  const handlePress = useCallback(() => {
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
  return (
    <MiniPlayerIconButton
      iconName="mirror"
      iconColor={isMirrored ? brandColors.primary : undefined}
      selected={isMirrored}
      accessibilityLabel={isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')}
      onPress={handlePress}
      size={size}
    />
  );
}

function MiniPlayerQueueButton({ size }: { size: number }) {
  const { t } = useTranslation('session');
  const { openQueueSheet, boardConfig } = useDrawerHost();
  const boardType = boardConfig?.boardName;
  const handlePress = useCallback(() => {
    trackQueueSheetOpened({ surface: 'mini_player', boardType });
    openQueueSheet();
  }, [openQueueSheet, boardType]);
  return (
    <MiniPlayerIconButton
      iconName="queue"
      accessibilityLabel={t('mobile.queueSnackbar.openAria')}
      onPress={handlePress}
      size={size}
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

/** ⏮ ⏭: their targets are walked only while one of them is on the bar. */
function MiniPlayerTransportButtons({
  buttonIds,
  renderSlot,
  size,
}: {
  buttonIds: readonly MiniPlayerButtonId[];
  renderSlot: (buttonId: MiniPlayerButtonId, button: ReactNode) => ReactNode;
  size: number;
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
              iconName="skip.previous"
              accessibilityLabel={t('playView.actionBar.previousAria')}
              onPress={navigation.onPrevious}
              disabled={!navigation.canPrevious}
              size={size}
            />
          ) : (
            <MiniPlayerIconButton
              iconName="skip.next"
              accessibilityLabel={t('playView.actionBar.nextAria')}
              onPress={navigation.onNext}
              disabled={!navigation.canNext}
              size={size}
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
            bluetoothConnected={bluetoothConnected}
          />
        ) : null;
      case 'share':
        return climbBoard ? <MiniPlayerShareButton climb={climb} climbBoard={climbBoard} size={slotWidth} /> : null;
      case 'queue':
        return <MiniPlayerQueueButton size={slotWidth} />;
      case 'angle':
        return angle !== null ? <MiniPlayerAngleButton angle={angle} climbUuid={angleClimbUuid} /> : null;
      case 'mirror':
        return climbBoard ? (
          <MiniPlayerMirrorButton
            queueItemUuid={queueItemUuid}
            climb={climb}
            climbBoard={climbBoard}
            size={slotWidth}
          />
        ) : null;
      // ⏮ ⏭ render below.
      default:
        return null;
    }
  };

  return (
    <>
      {others.map((buttonId) => renderSlot(buttonId, renderButton(buttonId)))}
      {transport.length > 0 ? (
        <MiniPlayerTransportButtons buttonIds={transport} renderSlot={renderSlot} size={slotWidth} />
      ) : null}
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
