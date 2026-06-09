/**
 * PersistentQueueBar — the persistent climb toolbar that mounts at the app root
 * and is visible on every screen while a current climb is set.
 *
 * It is a thin adapter: it decides *whether* the climb bar should show (a current
 * climb exists and the native iOS 26 bottom accessory isn't already owning it),
 * then lays it out per variant via {@link ActiveContextBar}:
 *
 *   Liquid Glass / fallback   [ grade · name ]        [ ✓ tick ]
 *     centered capsule + standalone hero tick (tap = PlayDrawer, swipe = prev/next)
 *
 *   Material                  [ ▢ grade · name              ✓ ]
 *     one full-width opaque active-context bar docked above the tab bar
 *
 * On the Liquid Glass variant on iOS 26 the native bottom accessory owns this
 * pair, so `jsQueueToolbarVisible` is false here and this returns null.
 */

import { MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT, TOOLBAR_RESERVE, TAB_BAR_HEIGHT, glassSize } from '../../theme/layout';
import { useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { state } = useQueue();
  const { variant } = useTheme();
  const bottomChrome = useBottomChromeMetrics();

  const currentClimb = state.currentClimbQueueItem?.climb;

  if (!bottomChrome.jsQueueToolbarVisible) return null;
  if (!currentClimb) return null;

  if (variant === 'material') {
    return (
      <ActiveContextBar
        fillPrimary
        dockToTabBar
        horizontalInset={0}
        primary={
          <ClimbCapsule
            fillWidth
            height={MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT}
            surfaceTreatment="docked"
            endAction={<LogAscentToolbarButton climb={currentClimb} size={glassSize.inline} />}
            endActionSize={glassSize.inline}
          />
        }
      />
    );
  }

  return <ActiveContextBar primary={<ClimbCapsule />} trailing={<LogAscentFab climb={currentClimb} />} />;
}
