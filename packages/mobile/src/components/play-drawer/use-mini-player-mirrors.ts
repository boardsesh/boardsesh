import { useCurrentClimbSurface } from '../../hooks/use-current-climb-surface';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { playerMirroredByMiniPlayer } from '../queue-control/mini-player-controls';

/**
 * Whether the MiniPlayer beside this player stands in for its first row (#7000,
 * the tablet rule): the open Duo's pane, or a tablet's player route. Then the
 * player's first row is the full-width wall button (`playerMirroredByMiniPlayer`).
 */
export function useMiniPlayerMirrorsPlayer(isPane: boolean): boolean {
  const { home } = useCurrentClimbSurface();
  const { isTablet } = useDeviceLayout();
  const phoneSplit = usePhoneSplit();
  return playerMirroredByMiniPlayer({ home, phoneSplit, isTablet, isPane });
}
