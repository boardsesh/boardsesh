import type { MiniPlayerHost } from '../components/queue-control/mini-player-controls';
import type { UiVariant } from '../theme/resolve-ui-variant';
import type { CurrentClimbHome } from './current-climb-surface';

/**
 * Which MiniPlayer bar this device draws, if any:
 *
 * - `nativeAccessory`: the iOS 26 tab-bar accessory (iPhone, iPad, the Duo).
 * - `materialCard`: the floating Material card above the JS tab bar (Android,
 *   and any Material-variant iPhone without the native accessory), plus the
 *   browser sidebar shell, where it accompanies the selection pane.
 * - `null`: no MiniPlayer. A native JS tablet pane holds the climb, or the
 *   Liquid Glass fallback floats the plain climb capsule, which has no buttons.
 *
 * The floating queue bar and the View options sheet both read this, so the
 * MiniPlayer tab shows exactly where a bar honours its buttons.
 */
export function resolveMiniPlayerHost({
  home,
  variant,
  platformOS,
  sidebarShell = false,
}: {
  home: CurrentClimbHome;
  variant: UiVariant;
  platformOS?: string;
  sidebarShell?: boolean;
}): MiniPlayerHost | null {
  if (home === 'nativeAccessory') return 'nativeAccessory';
  // Desktop keeps its selection pane and a cross-tab way back to the queue.
  if (platformOS === 'web' && sidebarShell) return 'materialCard';
  if (home === 'floatingBar' && variant === 'material') return 'materialCard';
  return null;
}
