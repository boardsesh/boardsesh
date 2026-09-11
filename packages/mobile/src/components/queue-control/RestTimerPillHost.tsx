// Mounts the rest-timer pill together with ITS OWN sheet instance (#5378).
//
// WHY TWICE: an @expo/ui sheet presents off the view controller that owns its
// subtree. A single root-level instance would present UNDER the `/play`
// transparent modal — the sheet flashes open and vanishes (#3505 / #3294, and
// `docs/mobile-sheets-vs-routes.md` rule 1). So the host is mounted at the app
// root AND inside the play drawer, exactly the way BleControlSheetHost is, and
// each mount owns its own `visible` state.

import { useCallback, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { resolveDetailPaneSurface } from '../../theme/size-class';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { RestTimerPill } from './RestTimerPill';
import { RestTimerSheet } from './RestTimerSheet';

export type RestTimerPillHostProps = {
  /** The 32pt drawer-header tier. See {@link RestTimerPill}'s `compact`. */
  compact?: boolean;
};

/**
 * The pill plus the sheet it opens. Gated on the timer actually being armed — an
 * unarmed timer has no pill, which is also why `armed` is never persisted (see
 * lib/rest-timer-store.ts).
 */
export function RestTimerPillHost({ compact = false }: RestTimerPillHostProps) {
  const armed = useRestTimerArmed();
  const [sheetVisible, setSheetVisible] = useState(false);

  const openSheet = useCallback(() => setSheetVisible(true), []);
  const closeSheet = useCallback(() => setSheetVisible(false), []);

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
  /** `BottomChromeMetrics.insideTabs`. */
  insideTabs: boolean;
  /** True on the regular-width iPad shell, where the sidebar replaces the tab bar. */
  usesSidebar: boolean;
};

/**
 * Whether the ROOT pill renders.
 *
 * This must agree with the bottom-chrome reserve, term for term. That reserve is
 *
 *     restTimerArmed && insideTabs && !usesSidebar        (bottom-chrome-metrics.ts)
 *
 * and if the two ever disagree the climber gets one of two visible bugs: a dead
 * 54pt gap under the last list row (reserve without a pill), or the pill sitting
 * on top of list rows (pill without a reserve). The two are now the SAME
 * expression, with no extra term on either side.
 *
 * Pinned by `rest-timer-pill-host.test.tsx`, which drives this against the real
 * `computeBottomChromeMetrics`.
 */
export function shouldRenderRestTimerPill({ armed, insideTabs, usesSidebar }: RestTimerPillGateInputs): boolean {
  return armed && insideTabs && !usesSidebar;
}

/**
 * The root overlay. A high-z absolute sibling of the navigator — the same shape
 * `AccessoryOnboardingTip` uses — so it floats above BOTH the iOS 26 UIKit
 * platter and the JS queue bar, on every route that reserves for it.
 *
 * The anchor is `bottomChrome.restTimerBottom` verbatim: it already clears the
 * tab bar and the active queue chrome exactly once. Adding an offset of our own
 * here is #4089's failure shape.
 */
export function RootRestTimerPillHost() {
  const armed = useRestTimerArmed();
  const bottomChrome = useBottomChromeMetrics();
  const { widthClass } = useDeviceLayout();
  const { width } = useWindowDimensions();

  // `usesSidebar` is the reserve's own term, recomputed from the same inputs.
  // The detail-pane check is the persistent-queue-bar bail-out and is strictly
  // narrower, so it is kept only as documentation of which shell this is.
  const usesSidebar = bottomChrome.insideTabs && widthClass === 'regular';
  const detailPaneOwnsQueue =
    usesSidebar && resolveDetailPaneSurface({ width, widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane';

  if (!shouldRenderRestTimerPill({ armed, insideTabs: bottomChrome.insideTabs, usesSidebar })) return null;
  // Unreachable while the gate above holds (a detail pane implies the sidebar),
  // but stated so the iPad shell's intent survives a future edit to either.
  if (detailPaneOwnsQueue) return null;

  return (
    <View pointerEvents="box-none" style={[styles.overlay, { bottom: bottomChrome.restTimerBottom }]}>
      <RestTimerPillHost />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    alignItems: 'center',
    // Above the tab bar / native accessory in z-order, and one rung BELOW the
    // onboarding tip (100) so a tip pointing at the bar still wins.
    zIndex: 90,
    elevation: 90,
  },
});
