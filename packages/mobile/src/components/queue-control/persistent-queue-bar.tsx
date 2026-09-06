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

import { useWindowDimensions } from 'react-native';
import { useSegments } from 'expo-router';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  SIDEBAR_WIDTH,
  TOOLBAR_RESERVE,
  TAB_BAR_HEIGHT,
  glassSize,
} from '../../theme/layout';
import { resolveDetailPaneSurface } from '../../theme/size-class';
import { useQueue, useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { isTopLevelTabRoute, tabsActiveSegment } from '../../lib/route-segments';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { ActiveContextBar } from './ActiveContextBar';
import { ClimbCapsule } from './ClimbCapsule';
import { LogAscentFab } from './LogAscentFab';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { ReturnToSessionButton } from './ReturnToSessionButton';

// Re-export so layout consumers that already import toolbar metrics from this
// module don't need to know which file owns them. Source of truth: theme/layout.
export { TOOLBAR_RESERVE, TAB_BAR_HEIGHT };

export function PersistentQueueBar() {
  const { state } = useQueue();
  const { variant } = useTheme();
  const segments = useSegments();
  const bottomChrome = useBottomChromeMetrics();
  const { widthClass } = useDeviceLayout();
  const { width } = useWindowDimensions();
  // sessionId-only subscription (mirrors the tab layout's own read) — a "return to
  // session" affordance while a session is live and the user isn't already on the
  // Record tab.
  const { sessionId } = useQueueSessionId();

  // Queue head only — the wall's lit climb lives in the top "On the wall" strip.
  const currentClimb = state.currentClimbQueueItem?.climb ?? null;
  const detailPaneOwnsQueue = resolveDetailPaneSurface({ width, widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane';

  // The iPad shell shows the current climb in the persistent right-column pane
  // (IpadPlayPane), so the floating bar must not also render there.
  if (detailPaneOwnsQueue) return null;
  if (!currentClimb) return null;
  // Show the climb bar only on a top-level tab page (a tab's own index), never on a
  // pushed sub-route or any root push/modal. This single gate subsumes the old
  // per-surface bail-outs — auth, gym-discovery, and the player are all non-tab
  // routes, and every in-tab sub-route is ≥ 3 segments deep, so all of them read as
  // not-top-level here.
  if (!isTopLevelTabRoute(segments)) return null;
  if (!bottomChrome.jsQueueToolbarVisible && bottomChrome.nativeAccessoryPresented) return null;

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

  // Excludes the Record tab itself — this bar renders on every top-level tab page
  // including Record's own index, so without this guard the button would point at
  // the screen it's already on.
  const onRecordTab = tabsActiveSegment(segments) === 'record';
  const showReturnToSession = sessionId !== null && !onRecordTab;

  return (
    <ActiveContextBar
      primary={
        <ClimbCapsule
          endAction={showReturnToSession ? <ReturnToSessionButton /> : undefined}
          endActionSize={showReturnToSession ? glassSize.inline : undefined}
        />
      }
      trailing={<LogAscentFab climb={currentClimb} />}
    />
  );
}
