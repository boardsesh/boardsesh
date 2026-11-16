import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '../EmptyState';
import { Button } from '../Button';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { boardHasLights, drivesWithoutBluetooth } from '../../lib/boards/board-lighting';
import { useSprayWallLedsEnabled } from '../../lib/spray/use-spray-wall-leds-enabled';
import { hapticSelection } from '../../lib/haptics';
import { trackBoardConnectTapped } from '../../lib/analytics-board-connect';
import { spacing } from '../../theme/tokens';

/**
 * The Wall display's empty state — a FALLBACK only. Board presence binds for
 * every climber with an active board, so `WallScreen`'s `isWallLive` gate is
 * normally already satisfied and the kiosk renders instead; this shows when the
 * board's render data can't be resolved or presence isn't bound.
 *
 * Climber voice, a board-shaped bulb glyph (no AI art), and a single CTA. On a
 * wall WITH lights it opens the device picker via the Bluetooth context's
 * `connect()` (hidden when no context is mounted — nothing to connect to). On a
 * wall flagged as having no light kit, or lit by a wall device that follows the
 * board feed, there is nothing to connect to, so the CTA takes the wall instead;
 * that branch reads the active board's flags (`drivesWithoutBluetooth`) so it
 * doesn't depend on the BLE provider being mounted.
 */
function WallEmptyStateComponent() {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const bluetooth = useOptionalBluetoothContext();
  // Optional-field contract: only an explicit `hasLeds: false` or
  // `litByWallDevice: true` takes the wall, so a missing/stale flag keeps the
  // Bluetooth connect CTA.
  const { data: activeBoard } = useActiveBoard();
  const ledless = drivesWithoutBluetooth(activeBoard);
  const sprayLedsEnabled = useSprayWallLedsEnabled(activeBoard?.boardType, activeBoard?.layoutId);
  // A wall device or this phone's LED setup lights the wall, so "this wall has
  // no lights" would be wrong.
  const body = !ledless
    ? t('mobile.boardPresence.wallEmptyBody')
    : boardHasLights(activeBoard) || sprayLedsEnabled
      ? t('mobile.boardPresence.wallEmptyBodyWallDevice')
      : t('mobile.boardPresence.wallEmptyBodyNoLeds');
  const takeVirtualWall = bluetooth?.takeVirtualWall;

  const handleConnect = useCallback(() => {
    hapticSelection();
    if (!bluetooth) return;
    trackBoardConnectTapped({ surface: 'wall_empty_state', boardName: bluetooth.boardName, reconnect: false });
    void bluetooth.connect();
  }, [bluetooth]);

  // No hapticSelection here: taking the wall is a state change, and
  // `takeVirtualWall` fires its own hapticLight with the "You've got the wall"
  // toast. A second buzz on the same tap reads as a stutter.
  const handleTakeWall = useCallback(() => {
    takeVirtualWall?.();
  }, [takeVirtualWall]);

  // `ledless` comes from the stored board rather than the Bluetooth context, so
  // the COPY is right even before the provider mounts. The button still needs
  // something to call, though: rendering one that silently does nothing is worse
  // than rendering none.
  const action =
    ledless && takeVirtualWall ? (
      <Button
        title={t('mobile.boardPresence.wallEmptyCtaNoLeds')}
        variant="filled"
        icon="pin"
        onPress={handleTakeWall}
        // The handler stays silent so `takeVirtualWall`'s own hapticLight is
        // the single buzz for this tap.
        haptic={false}
      />
    ) : !ledless && bluetooth ? (
      <Button
        title={t('mobile.boardPresence.wallEmptyCta')}
        variant="filled"
        icon="lightbulb"
        onPress={handleConnect}
      />
    ) : undefined;

  return (
    <EmptyState
      size="screen"
      icon="lightbulb"
      title={t('mobile.boardPresence.wallEmptyTitle')}
      body={body}
      titleVariant="title2"
      maxContentWidth={420}
      actions={action}
      style={{
        paddingTop: insets.top + spacing[10],
        paddingBottom: insets.bottom + spacing[8],
        paddingHorizontal: spacing[8],
      }}
    />
  );
}

export const WallEmptyState = memo(WallEmptyStateComponent);
