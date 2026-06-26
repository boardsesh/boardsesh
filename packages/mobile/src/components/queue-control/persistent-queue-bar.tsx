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

import { useSegments } from 'expo-router';
import { MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT, TOOLBAR_RESERVE, TAB_BAR_HEIGHT, glassSize } from '../../theme/layout';
import { useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { isAuthRoute, isGymDiscoveryRoute, isPlayerRoute } from '../../lib/route-segments';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';
import { useAccessoryPresentation } from './use-accessory-presentation';
import { shouldHideQueueBarOnSocial } from './use-queue-bar-hidden';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { state } = useQueue();
  const { variant } = useTheme();
  const segments = useSegments();
  const bottomChrome = useBottomChromeMetrics();

  const currentClimb = useWallOrQueueCurrentClimb(state.currentClimbQueueItem?.climb ?? null);
  // One connection-state read here: `showTick` hides the tick for a peer's climb,
  // and `tier` feeds the social-surface hide. The hide uses the same pure
  // predicate as useBottomChromeMetrics (which drops the reserved space), so a
  // hidden bar never strands a gap — see shouldHideQueueBarOnSocial.
  const { showTick, tier } = useAccessoryPresentation();
  const nowPlayingFlag = useFeatureFlag('accessory-now-playing') === true;
  const hiddenOnSocial = shouldHideQueueBarOnSocial(nowPlayingFlag, tier, segments);

  if (!currentClimb) return null;
  // The sign-in / sign-up flow is pre-auth — a leftover queued or "on the wall"
  // climb must not float a tick bar over the login screen.
  if (isAuthRoute(segments)) return null;
  // The gym-discovery screen is a full-bleed map with its own bottom sheet — the
  // climb accessory would overlap it, so suppress it there.
  if (isGymDiscoveryRoute(segments)) return null;
  // The full-screen player owns the whole surface (with its own queue UI). On iOS
  // the line below already hides this via the mounted native accessory, but on
  // Android (no native accessory) the bar would otherwise show over the player.
  if (isPlayerRoute(segments)) return null;
  // On social/browsing tabs a queue-only bar (nothing lit) reads as a directive,
  // so hide it there. When a board is live the now-playing bar persists as status.
  if (hiddenOnSocial) return null;
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
            endAction={showTick ? <LogAscentToolbarButton climb={currentClimb} size={glassSize.inline} /> : undefined}
            endActionSize={glassSize.inline}
          />
        }
      />
    );
  }

  return (
    <ActiveContextBar
      primary={<ClimbCapsule />}
      trailing={showTick ? <LogAscentFab climb={currentClimb} /> : undefined}
    />
  );
}
