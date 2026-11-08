import { StyleSheet } from 'react-native';
import { AccessoryBarSurface } from '../queue-control/AccessoryBarSurface';
import { MiniPlayerAccessoryBody } from '../queue-control/MiniPlayerAccessoryBody';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { MATERIAL_MINI_PLAYER_CARD_HEIGHT } from '../../theme/layout';
import { borderRadius } from '../../theme/tokens';

/**
 * The Material MiniPlayer: a rounded card floating above the JS tab bar, the way
 * Spotify and YouTube Music float theirs, holding the same row iOS draws in its
 * tab-bar accessory (`MiniPlayerAccessoryBody`): the climb, the climber's
 * MiniPlayer buttons, Board light and Log.
 *
 * The card owns only the surface: the M3 `surfaceContainer` tone at level-2
 * elevation, stepping to the violet tonal wash and level 3 while this phone
 * drives the wall, as the active tab pill does. `PersistentQueueBar` positions
 * it (8dp from each edge, straight on the measured tab bar) and decides when it
 * shows. It is never collapsed, so the row always gets the `regular` placement.
 */
export function FloatingMiniPlayerCard() {
  const { inAppBoardConnection } = useBoardConnectionState();
  return (
    <AccessoryBarSurface
      height={MATERIAL_MINI_PLAYER_CARD_HEIGHT}
      borderRadius={borderRadius.lg}
      emphasis={inAppBoardConnection === 'connectedByMe' ? 'connected' : 'none'}
      style={styles.card}
    >
      <MiniPlayerAccessoryBody placement="regular" host="materialCard" />
    </AccessoryBarSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
  },
});
