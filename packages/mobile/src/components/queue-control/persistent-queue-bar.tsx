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

import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  TOOLBAR_RESERVE,
  TAB_BAR_HEIGHT,
  IPAD_TICK_FAB_SIZE,
  glassSize,
} from '../../theme/layout';
import { isIpad } from '../../lib/is-ipad';
import { useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { state } = useQueue();
  const { variant } = useTheme();
  const bottomChrome = useBottomChromeMetrics();

  const currentClimb = useWallOrQueueCurrentClimb(state.currentClimbQueueItem?.climb ?? null);

  if (!currentClimb) return null;
  if (!bottomChrome.jsQueueToolbarVisible && bottomChrome.nativeAccessoryMounted) return null;

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
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

  // iPad bumps the hero tick up a step so it reads at arm's length; the bar's
  // trailing slot widens to match.
  const tickSize = isIpad ? IPAD_TICK_FAB_SIZE : glassSize.hero;
  return (
    <ActiveContextBar
      primary={<ClimbCapsule />}
      trailing={<LogAscentFab climb={currentClimb} size={tickSize} />}
      trailingWidth={tickSize}
    />
  );
}
