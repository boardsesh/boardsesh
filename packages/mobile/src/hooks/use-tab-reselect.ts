import { useEffect, useEffectEvent } from 'react';
import { useNavigation } from 'expo-router';
import type { NavigationProp, NavigationState, ParamListBase } from 'expo-router/react-navigation';

// `tabPress` as the parent tab navigator sends it. NativeTabs sets `isPrevented`
// when the tapped tab is disabled; the JS Tabs bar sends no data.
type TabPressEventMap = {
  tabPress: { data: { isPrevented?: boolean } | undefined };
};
type TabNavigation = NavigationProp<
  ParamListBase,
  string,
  string | undefined,
  NavigationState,
  object,
  TabPressEventMap
>;

/**
 * Call `onReselect` when the climber taps this screen's tab while already looking
 * at this screen: the tab is selected and this screen is the top of its stack.
 * A tap that arrives from another tab, or from a route pushed on top (where the
 * native bar pops back to this screen), does not count.
 *
 * Mount from the tab's root screen, where the parent navigator is the tab
 * navigator. The navigator emits `tabPress` before it acts on the press, so the
 * screen's focus at that moment says whether the tab was already open.
 * `onReselect` runs on the next frame, after the bar's own repeat-tap effects
 * (scroll to top) have started. The listener always calls the latest
 * `onReselect`, so a caller need not memoise it.
 */
export function useTabReselect(onReselect: () => void): void {
  const navigation = useNavigation();
  const handleReselect = useEffectEvent(onReselect);

  useEffect(() => {
    const tabNavigation = navigation.getParent<TabNavigation | undefined>();
    if (tabNavigation == null) return;

    let frame: number | null = null;
    const unsubscribe = tabNavigation.addListener('tabPress', (event) => {
      if (event.data?.isPrevented || !navigation.isFocused()) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        handleReselect();
      });
    });

    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [navigation]);
}
