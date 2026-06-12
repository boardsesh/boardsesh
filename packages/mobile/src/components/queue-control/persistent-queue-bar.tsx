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
 *   Active session            [ Rest timer ]
 *                             [ grade · name ]        [ ✓ tick ]
 *
 * On the Liquid Glass variant on iOS 26 the native bottom accessory owns this
 * pair, so `jsQueueToolbarVisible` is false and this mounts only the optional
 * rest-timer capsule above the native accessory.
 */

import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  TOOLBAR_GAP,
  TOOLBAR_GAP_ABOVE_TABBAR,
  TOOLBAR_RESERVE,
  TAB_BAR_HEIGHT,
  glassSize,
} from '../../theme/layout';
import { useQueue } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { useNativeAccessoryPlacement } from '../../hooks/use-bottom-accessory';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useRepTimerPreference } from '../../lib/rep-timer-preference';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { RepTimerCapsule } from './RepTimerCapsule';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { state, sessionId } = useQueue();
  const { variant } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const nativeAccessoryPlacement = useNativeAccessoryPlacement();
  const { targetSeconds, loaded: repTimerPreferenceLoaded } = useRepTimerPreference();

  const currentClimb = useWallOrQueueCurrentClimb(state.currentClimbQueueItem?.climb ?? null);
  const isSessionActive = sessionId !== null;
  const showRepTimer = isSessionActive && repTimerPreferenceLoaded && targetSeconds !== null;
  const nativeAccessoryHeight = nativeAccessoryPlacement === 'inline' ? glassSize.inline : glassSize.standard;

  if (!currentClimb) return null;
  if (!bottomChrome.jsQueueToolbarVisible && bottomChrome.nativeAccessoryMounted) {
    return showRepTimer ? (
      <ActiveContextBar
        primary={<RepTimerCapsule />}
        gapAboveTabBar={nativeAccessoryHeight + TOOLBAR_GAP_ABOVE_TABBAR + TOOLBAR_GAP}
      />
    ) : null;
  }

  const liquidRepTimerGapAboveTabBar = TOOLBAR_GAP_ABOVE_TABBAR + glassSize.hero + TOOLBAR_GAP;
  const materialRepTimerDockOffset = MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT + TOOLBAR_GAP_ABOVE_TABBAR;

  if (variant === 'material') {
    return (
      <>
        {showRepTimer ? (
          <ActiveContextBar dockToTabBar dockOffset={materialRepTimerDockOffset} primary={<RepTimerCapsule />} />
        ) : null}
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
      </>
    );
  }

  return (
    <>
      {showRepTimer ? (
        <ActiveContextBar primary={<RepTimerCapsule />} gapAboveTabBar={liquidRepTimerGapAboveTabBar} />
      ) : null}
      <ActiveContextBar primary={<ClimbCapsule />} trailing={<LogAscentFab climb={currentClimb} />} />
    </>
  );
}
