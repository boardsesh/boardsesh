// Mounts the rest-timer pill together with ITS OWN sheet instance (#5378).
//
// WHY TWICE: an @expo/ui sheet presents off the view controller that owns its
// subtree. A single root-level instance would present UNDER the `/play`
// transparent modal — the sheet flashes open and vanishes (#3505 / #3294, and
// `docs/mobile-sheets-vs-routes.md` rule 1). So the host is mounted at the app
// root AND inside the play drawer, exactly the way BleControlSheetHost is, and
// each mount owns its own `visible` state.

import { useCallback, useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';
import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { useStartWorkout } from '../../hooks/use-start-workout';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useWorkoutRunPendingStart } from '../../lib/workout-run-store';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useCurrentClimbSurface } from '../../hooks/use-current-climb-surface';
import { spacing } from '../../theme/tokens';
import { RestTimerPill, WorkoutStartPill } from './RestTimerPill';
import { RestTimerSheet } from './RestTimerSheet';

export type RestTimerPillHostProps = {
  /** The 32pt drawer-header tier. See {@link RestTimerPill}'s `compact`. */
  compact?: boolean;
};

/**
 * A prepared workout offers its explicit Start before the timer's clock and
 * settings sheet. Otherwise an unarmed timer has no pill.
 */
export function RestTimerPillHost({ compact = false }: RestTimerPillHostProps) {
  const armed = useRestTimerArmed();
  const { pending, firstItem, startWorkout } = useStartWorkout();
  const [sheetVisible, setSheetVisible] = useState(false);

  const openSheet = useCallback(() => setSheetVisible(true), []);
  const closeSheet = useCallback(() => setSheetVisible(false), []);

  if (pending) {
    return <WorkoutStartPill compact={compact} onPress={startWorkout} firstClimbName={firstItem?.climb.name ?? null} />;
  }
  if (!armed) return null;

  return (
    <>
      <RestTimerPill compact={compact} onPress={openSheet} />
      <RestTimerSheet visible={sheetVisible} onClose={closeSheet} />
    </>
  );
}

export type RestTimerPillGateInputs = {
  armed: boolean;
  workoutStartPending?: boolean;
  /** `BottomChromeMetrics.insideTabs`. */
  insideTabs: boolean;
  /** True on the regular-width JS tablet shell, where its rail replaces the tab bar. */
  usesSidebar: boolean;
  /** `BottomChromeMetrics.restTimerPillHiddenOnRoute`: the Session page while the timer is idle. */
  hiddenOnRoute?: boolean;
};

/**
 * Whether the ROOT pill renders.
 *
 * This must agree with the bottom-chrome reserve, term for term. That reserve is
 *
 *     (restTimerArmed || workoutStartPending) && insideTabs && !usesSidebar && !restTimerPillHiddenOnRoute
 *
 * and if the two ever disagree the climber gets one of two visible bugs: a dead
 * 54pt gap under the last list row (reserve without a pill), or the pill sitting
 * on top of list rows (pill without a reserve). The two are now the SAME
 * expression, with no extra term on either side.
 *
 * Pinned by `rest-timer-pill-host.test.tsx`, which drives this against the real
 * `computeBottomChromeMetrics`.
 */
export function shouldRenderRestTimerPill({
  armed,
  workoutStartPending = false,
  insideTabs,
  usesSidebar,
  hiddenOnRoute = false,
}: RestTimerPillGateInputs): boolean {
  return (armed || workoutStartPending) && insideTabs && !usesSidebar && !hiddenOnRoute;
}

/**
 * The root overlay. A high-z absolute sibling of the navigator — the same shape
 * `AccessoryOnboardingTip` uses — so it floats above BOTH the iOS 26 UIKit
 * platter and the JS queue bar, on every route that reserves for it.
 *
 * The anchor is `bottomChrome.restTimerBottom` verbatim: it already clears the
 * tab bar and the active queue chrome exactly once. Adding an offset of our own
 * here is #4089's failure shape. Horizontally it sits on the content column
 * (`contentColumnLeft` / `contentColumnRight`), the same span as the accessory.
 */
export function RootRestTimerPillHost() {
  const armed = useRestTimerArmed();
  const { sessionId } = useQueueSessionId();
  const workoutStartPending = useWorkoutRunPendingStart(sessionId);
  const bottomChrome = useBottomChromeMetrics();
  // `usesSidebar` is the reserve's own term, from the same resolver the reserve
  // reads. The native iPad is not the sidebar shell, so there the pill floats
  // above the accessory exactly as on iPhone.
  const { sidebarShell } = useCurrentClimbSurface();
  const usesSidebar = bottomChrome.insideTabs && sidebarShell;

  if (
    !shouldRenderRestTimerPill({
      armed,
      workoutStartPending,
      insideTabs: bottomChrome.insideTabs,
      usesSidebar,
      hiddenOnRoute: bottomChrome.restTimerPillHiddenOnRoute,
    })
  ) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        {
          bottom: bottomChrome.restTimerBottom,
          // Centre on the column the accessory spans, not the window: the native
          // iPad sidebar and the iPhone Duo rail take a side of it.
          ...physicalHorizontalInsets(
            spacing[3] + bottomChrome.contentColumnLeft,
            spacing[3] + bottomChrome.contentColumnRight,
          ),
        },
      ]}
    >
      <RestTimerPillHost />
    </View>
  );
}

/**
 * Safe-area insets are physical (the sidebar is on the left whatever the
 * language), but React Native swaps `left` and `right` in a right-to-left
 * layout by default. Swap them back there so the offsets stay on the side the
 * inset came from. No shipped locale is right-to-left yet; this keeps the pill
 * right when one is.
 */
function physicalHorizontalInsets(left: number, right: number): { left: number; right: number } {
  const swapped = I18nManager.isRTL && I18nManager.doLeftAndRightSwapInRTL;
  return swapped ? { left: right, right: left } : { left, right };
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    alignItems: 'center',
    // Above the tab bar / native accessory in z-order, and one rung BELOW the
    // onboarding tip (100) so a tip pointing at the bar still wins.
    zIndex: 90,
    elevation: 90,
  },
});
