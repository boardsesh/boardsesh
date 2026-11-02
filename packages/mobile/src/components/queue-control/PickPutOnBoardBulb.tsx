import { useCallback, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useDifferentiateWithoutColor } from '../../hooks/use-differentiate-without-color';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { lastPickOpenOptions, type LastPick } from '../../lib/last-pick-store';
import { glassSize } from '../../theme/layout';
import { useWallClimb } from '../play-drawer/use-wall-climb';
import { getBoardControlIndicatorVisual } from './board-control-indicator-state';

/**
 * Put on board for the climber's last pick, from the MiniPlayer's bulb (owner
 * decision A): the player opens on the pick as the same preview, with its list,
 * and presses Put on board once it lands (`putOnBoard`), through the wall
 * button's own handler. So it is the wall button's path exactly: in a crew the
 * busy-wall question asks first (against the wall as it was when the climber
 * started looking), and the timed drive starts per Stop driving after. The
 * player is where that question, and the drive's frosted button, can be seen.
 */
export function usePickPutOnBoard(pick: LastPick | null): () => void {
  const { openPlayDrawer } = useDrawerHost();
  return useCallback(() => {
    if (!pick) return;
    // The player's press buzzes; a second buzz here would double it.
    openPlayDrawer(pick.item.climb, { ...lastPickOpenOptions(pick), putOnBoard: true });
  }, [openPlayDrawer, pick]);
}

/** Whether the wall shows the pick: the bar's own bulb then speaks for it, as for any climb. */
export function usePickLit(pick: LastPick): boolean {
  const wallClimb = useWallClimb();
  return wallClimb.uuid !== null && wallClimb.uuid === pick.item.climb.uuid;
}

type PickBulbSlotProps = {
  pick: LastPick;
  /** The bar's usual bulb, for a pick that is lit. */
  litBulb: ReactNode;
  size?: number;
  iconSize?: number;
  /** Filled glyphs, like the platter's other controls (see `BoardControlIndicator`). */
  solidGlyphs?: boolean;
};

/**
 * The MiniPlayer's bulb while it shows the climber's last pick. No extra
 * marking: the bulb says whether the pick is lit. Lit (the wall shows it), it
 * is the bar's usual bulb. Not lit, it reads off (the outline bulb, or the pin
 * on a board with no lights) and a tap puts the pick on the board
 * (`usePickPutOnBoard`).
 */
export function PickBulbSlot({
  pick,
  litBulb,
  size = glassSize.inline,
  iconSize = 22,
  solidGlyphs = false,
}: PickBulbSlotProps) {
  const lit = usePickLit(pick);
  if (lit) return <>{litBulb}</>;
  return <PickPutOnBoardBulb pick={pick} size={size} iconSize={iconSize} solidGlyphs={solidGlyphs} />;
}

function PickPutOnBoardBulb({
  pick,
  size,
  iconSize,
  solidGlyphs,
}: {
  pick: LastPick;
  size: number;
  iconSize: number;
  solidGlyphs: boolean;
}) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const differentiateWithoutColor = useDifferentiateWithoutColor();
  const { ledless, bluetooth } = useBoardConnectionState();
  const putOnBoard = usePickPutOnBoard(pick);
  // No board bound: nothing to put it on, as the bar's usual bulb.
  if (!bluetooth) return null;
  const visual = getBoardControlIndicatorVisual({
    boardConnection: 'disconnected',
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
    ledless,
    wallHeldColor: brandColors.primary,
    solidGlyphs: solidGlyphs && differentiateWithoutColor !== 'on',
  });
  return (
    <PressableSurface
      testID="mini-player-pick-put-on-board"
      onPress={putOnBoard}
      accessibilityRole="button"
      accessibilityLabel={t('playView.wallControl.putOnBoard')}
      accessibilityHint={t('playView.wallControl.lightHint')}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon maxFontSizeMultiplier={1} name={visual.iconName} size={iconSize} color={visual.iconColor} />
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
