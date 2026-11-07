import type { MiniPlayerHost } from '../components/queue-control/mini-player-controls';
import type { UiVariant } from '../theme/resolve-ui-variant';
import type { CurrentClimbHome } from './current-climb-surface';

/**
 * Which MiniPlayer bar this device draws, if any:
 *
 * - `nativeAccessory`: the iOS 26 tab-bar accessory (iPhone, iPad, the Duo).
 * - `materialCard`: the floating Material card above the JS tab bar (Android,
 *   and any Material-variant iPhone without the native accessory).
 * - `null`: no MiniPlayer. The JS tablet shell's pane holds the climb, or the
 *   Liquid Glass fallback floats the plain climb capsule, which has no buttons.
 *
 * The floating queue bar and the View options sheet both read this, so the
 * MiniPlayer tab shows exactly where a bar honours its buttons.
 */
export function resolveMiniPlayerHost({
  home,
  variant,
}: {
  home: CurrentClimbHome;
  variant: UiVariant;
}): MiniPlayerHost | null {
  if (home === 'nativeAccessory') return 'nativeAccessory';
  if (home === 'floatingBar' && variant === 'material') return 'materialCard';
  return null;
}
