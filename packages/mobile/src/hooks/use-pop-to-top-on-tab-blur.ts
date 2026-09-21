import { useEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * Pops this tab's own nested stack to its first screen when the tab itself
 * loses focus (switching to another bottom tab), never while navigating
 * deeper within it. Mount from a tab's `_layout.tsx` — that component IS the
 * tab's screen from the parent navigator's view, so `useNavigation()` here is
 * bound to the parent (whichever tab bar renders it), not the nested `Stack`.
 * `@react-navigation/bottom-tabs`'s `popToTopOnBlur` screen option does this
 * for the JS tab bar only — `NativeTabs` (iOS 26) has no equivalent, so this
 * dispatches the same targeted `POP_TO_TOP` by hand over the tab-bar-agnostic
 * core APIs, covering Material, the iPad shell, and NativeTabs from one path.
 *
 * @param tabName the route name this tab is registered under in the parent
 * tab navigator (e.g. "profile"), matching its `Tabs.Screen`/`NativeTabs.Trigger` name.
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
