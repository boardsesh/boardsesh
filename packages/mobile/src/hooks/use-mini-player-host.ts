import type { MiniPlayerHost } from '../components/queue-control/mini-player-controls';
import { useTheme } from '../providers/theme-provider';
import { resolveMiniPlayerHost } from './mini-player-host';
import { useCurrentClimbSurface } from './use-current-climb-surface';

/** Which MiniPlayer bar this device draws right now. See `resolveMiniPlayerHost`. */
export function useMiniPlayerHost(): MiniPlayerHost | null {
  const { home } = useCurrentClimbSurface();
  const { variant } = useTheme();
  return resolveMiniPlayerHost({ home, variant });
}
