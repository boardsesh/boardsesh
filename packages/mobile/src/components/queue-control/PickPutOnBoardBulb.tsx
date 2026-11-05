import { useCallback, type ReactNode } from 'react';
import { StyleSheet, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useDifferentiateWithoutColor } from '../../hooks/use-differentiate-without-color';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { lastPickOpenOptions, type LastPick } from '../../lib/last-pick-store';
import { hapticMedium } from '../../lib/haptics';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import { glassSize } from '../../theme/layout';
import { useDriveLightingMode } from '../play-drawer/drive-mode-store';
import { WallWindowRing } from '../play-drawer/WallWindowRing';
import { getBoardConnectionLabel, getBoardControlIndicatorVisual } from './board-control-indicator-state';
import { phoneDrivesTheWall, resolveBulbDriveCue } from './bulb-drive-cue';
import { readBarBulbTap, useBarBulbStopDriving } from './bar-bulb-tap';
import type { PickBulb } from './use-pick-bulb';

/**
 * Put on board for the climber's last pick, from the MiniPlayer's bulb (owner
 * decision A): the player opens on the pick as the same preview, with its list,
 * and presses Put on board once it lands (`putOnBoard`), through the wall
 * button's own handler. So it is the wall button's path exactly: in a crew the
 * busy-wall question asks first (against the wall as it was when the climber
 * started looking), the timed drive starts per Stop driving after, a climb on
 * another board at this gym moves there, and a climb presence says is still up
 * with no link lights again. The player is where that question, and the
 * drive's frosted button, can be seen.
 */
export function usePickPutOnBoard(pick: LastPick | null): () => void {
  const { openPlayDrawer } = useDrawerHost();
  return useCallback(() => {
    if (!pick) return;
    // The player's press buzzes; a second buzz here would double it.
    openPlayDrawer(pick.item.climb, { ...lastPickOpenOptions(pick), putOnBoard: true });
  }, [openPlayDrawer, pick]);
}

type PickBulbSlotProps = {
  pick: LastPick;
  /** What the bulb is for this pick (`usePickBulb`), resolved once by the bar. */
  bulb: PickBulb;
  /** The bar's usual bulb, for a pick that is lit. */
  litBulb: ReactNode;
  size?: number;
  iconSize?: number;
  /** Filled glyphs, like the platter's other controls (see `BoardControlIndicator`). */
  solidGlyphs?: boolean;
  /** The long press opens the board controls, as on the bar's usual bulb. */
  enableLongPress?: boolean;
  /** The accessory platter's placement, when this bulb sits on the platter (analytics). */
  placement?: AccessoryPlacement;
};

/**
 * The MiniPlayer's bulb while it shows the climber's last pick. No extra
 * marking: the bulb says whether the pick is lit. Lit (the wall shows it, over
 * a live link), it is the bar's usual bulb. Not lit, it reads off (the outline
 * bulb, or the pin on a board with no lights) and a tap puts the pick on the
 * board (`usePickPutOnBoard`). A climb this wall can't light, with no board at
 * the gym to walk to, gets no bulb, as the player offers no board control.
 * While this phone drives the wall the unlit pick's bulb is ringed in amber
 * (`BulbDriveCue`): the timed drive's ring drains, an open-ended drive's stays
 * whole, so the bar still says how long picks keep lighting. A tap then stops
 * driving and keeps the link, as on every bar bulb (owner, 2026-11-03;
 * `bar-bulb-tap.ts`), and the bulb says "Stop driving".
 */
export function PickBulbSlot({
  pick,
  bulb,
  litBulb,
  size = glassSize.inline,
  iconSize = 22,
  solidGlyphs = false,
  enableLongPress = false,
  placement,
}: PickBulbSlotProps) {
  if (bulb.kind === 'lit') return <>{litBulb}</>;
  if (bulb.kind === 'none') return null;
  return (
    <PickPutOnBoardBulb
      pick={pick}
      gymBoardName={bulb.gymBoardName}
      size={size}
      iconSize={iconSize}
      solidGlyphs={solidGlyphs}
      enableLongPress={enableLongPress}
      placement={placement}
    />
  );
}

function PickPutOnBoardBulb({
  pick,
  gymBoardName,
  size,
  iconSize,
  solidGlyphs,
  enableLongPress,
  placement,
}: {
  pick: LastPick;
  gymBoardName: string | null;
  size: number;
  iconSize: number;
  solidGlyphs: boolean;
  enableLongPress: boolean;
  placement: AccessoryPlacement | undefined;
}) {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const differentiateWithoutColor = useDifferentiateWithoutColor();
  const { ledless, bluetooth, localConnected, inAppBoardConnection, holderDisplayName } = useBoardConnectionState();
  const lightingMode = useDriveLightingMode();
  const { open: openBoardControls } = useBleControlSheet();
  const putOnBoard = usePickPutOnBoard(pick);
  const stopDriving = useBarBulbStopDriving(localConnected, 'mini_bar');
  const drivesTheWall = phoneDrivesTheWall({ inAppBoardConnection, localConnected, ledless });
  const handlePress = useCallback(() => {
    const tap = readBarBulbTap(drivesTheWall);
    if (tap === 'stop_driving') {
      stopDriving();
      return;
    }
    // A double tap's second tap after a stop, or a stop aimed at a timed drive
    // that ran out under the thumb: never a Put on board and a fresh drive.
    if (tap === 'held') return;
    putOnBoard();
  }, [drivesTheWall, stopDriving, putOnBoard]);
  // The board controls, as on the usual bulb: gated on a real Bluetooth link,
  // since every action in that sheet writes the radio.
  const handleLongPress = useCallback(() => {
    if (!localConnected) return;
    hapticMedium();
    openBoardControls({ surface: 'board_control_indicator', placement });
  }, [localConnected, openBoardControls, placement]);
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );
  // No board bound: nothing to put it on, as the bar's usual bulb.
  if (!bluetooth) return null;
  // This pick isn't the lit climb, so an open-ended drive is a whole ring, never the disc.
  const driveCue = resolveBulbDriveCue({ mode: lightingMode, drivesTheWall, showsLitClimb: false });
  const visual = getBoardControlIndicatorVisual({
    boardConnection: 'disconnected',
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
    ledless,
    localConnected,
    wallHeldColor: brandColors.primary,
    solidGlyphs: solidGlyphs && differentiateWithoutColor !== 'on',
  });
  // The player's own words for the press: Put on {board} where it moves to
  // another board at this gym. The hint says the player opens first. While
  // driving, the tap stops the drive, and the bulb says so.
  const accessibilityLabel = driveCue
    ? tSettings('ble.barControl.stopDrivingLabel')
    : gymBoardName
      ? t('playView.wallControl.putOnGymBoard', { board: gymBoardName })
      : t('playView.wallControl.putOnBoard');
  const accessibilityHint = driveCue
    ? tSettings('ble.barControl.stopDrivingHint')
    : gymBoardName
      ? t('playView.wallControl.pickMoveToGymBoardHint', { board: gymBoardName })
      : t('playView.wallControl.pickLightHint');
  // The usual bulb speaks the board's connection; this one stands in its
  // place, so the connection is still heard on the bar.
  const connectionValue = getBoardConnectionLabel(tSettings, {
    boardConnection: inAppBoardConnection,
    ledless,
    localConnected,
    holderDisplayName,
  });
  const accessibilityValue = driveCue
    ? `${connectionValue}, ${tSettings('ble.barControl.drivingValue')}`
    : connectionValue;
  const accessibilityActions =
    enableLongPress && localConnected ? [{ name: 'longpress', label: tSettings('ble.holdForControls') }] : undefined;
  return (
    <PressableSurface
      testID="mini-player-pick-put-on-board"
      onPress={handlePress}
      onLongPress={enableLongPress ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityValue={{ text: accessibilityValue }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={accessibilityActions ? handleAccessibilityAction : undefined}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon maxFontSizeMultiplier={1} name={visual.iconName} size={iconSize} color={visual.iconColor} />
      {driveCue === 'drain' || driveCue === 'whole' ? <WallWindowRing size={size} kind={driveCue} /> : null}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
