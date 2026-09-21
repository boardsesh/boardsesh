import { useEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * Pops THIS tab's own nested stack back to its first screen whenever the tab
 * itself loses focus (switching to a different bottom tab) — never while
 * staying on the tab and pushing deeper into it. Mount once from a tab's
 * `_layout.tsx`: that component IS the tab's own screen as far as the parent
 * tab navigator is concerned, so `useNavigation()` here is bound to the
 * PARENT (whichever tab bar renders it), not the nested `Stack` the layout
 * itself renders.
 *
 * `@react-navigation/bottom-tabs` has a declarative `popToTopOnBlur` screen
 * option for exactly this, but it only exists for that JS tab bar — `NativeTabs`
 * (iOS 26 Liquid Glass) has no equivalent option, so this reimplements the same
 * targeted `POP_TO_TOP` dispatch over the tab-bar-agnostic core navigation APIs,
 * covering Material, the iPad shell, and NativeTabs from one code path.
 *
 * @param tabName the route name this tab is registered under in the parent tab
 * navigator (e.g. "profile"), matching its `Tabs.Screen` / `NativeTabs.Trigger` name.
 */
export function usePopToTopOnTabBlur(tabName: string): void {
  const navigation = useNavigation();

  useEffect(() => {
    return navigation.addListener('blur', () => {
      const parentState = navigation.getState();
      const ownRoute = parentState?.routes.find((route) => route.name === tabName);
      const nestedState = ownRoute?.state;
      if (nestedState == null || nestedState.type !== 'stack' || typeof nestedState.key !== 'string') return;
      const topIndex = nestedState.index ?? nestedState.routes.length - 1;
      if (topIndex <= 0) return;
      navigation.dispatch({ type: 'POP_TO_TOP', target: nestedState.key });
    });
  }, [navigation, tabName]);
}
