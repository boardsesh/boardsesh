import { useEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * Reset this tab's nested history only when another tab becomes selected.
 * Mount from a tab's `_layout.tsx`, where useNavigation refers to the parent
 * tab navigator. Root modals can blur that screen without changing tabs, so
 * observe tab state instead of blur (which can precede the tab state update).
 * This also covers NativeTabs, which has no popToTopOnBlur screen option.
 */
export function usePopToTopOnTabBlur(tabName: 'profile' | 'discover' | 'climbs'): void {
  const navigation = useNavigation();

  useEffect(() => {
    let previousSelectedKey: string | undefined;
    let warnedMissingTabRoute = false;

    const handleState = (parentState: ReturnType<typeof navigation.getState> | undefined) => {
      if (
        parentState?.type !== 'tab' ||
        parentState.stale !== false ||
        parentState.routes == null ||
        typeof parentState.index !== 'number' ||
        parentState.routes[parentState.index]?.key == null
      ) {
        // A partial/hydrating snapshot cannot prove that this tab was left.
        previousSelectedKey = undefined;
        return;
      }

      const ownRoute = parentState.routes.find((route) => route.name === tabName);
      if (ownRoute == null) {
        if (__DEV__ && !warnedMissingTabRoute) {
          console.warn(`[usePopToTopOnTabBlur] Tab route "${tabName}" was not found in the parent tab navigator.`);
          warnedMissingTabRoute = true;
        }
        previousSelectedKey = undefined;
        return;
      }

      const selectedRoute = parentState.routes[parentState.index];
      const leftOwnTab = previousSelectedKey === ownRoute.key && selectedRoute.key !== ownRoute.key;
      // Update before dispatch: POP_TO_TOP itself emits another state event.
      previousSelectedKey = selectedRoute.key;
      if (!leftOwnTab) return;

      const nestedState = ownRoute.state;
      if (
        nestedState?.type !== 'stack' ||
        typeof nestedState.key !== 'string' ||
        typeof nestedState.index !== 'number' ||
        nestedState.index <= 0 ||
        nestedState.routes == null ||
        nestedState.index >= nestedState.routes.length
      ) {
        return;
      }
      navigation.dispatch({ type: 'POP_TO_TOP', target: nestedState.key });
    };

    const unsubscribe = navigation.addListener('state', (event) => handleState(event.data.state));
    handleState(navigation.getState());
    return unsubscribe;
  }, [navigation, tabName]);
}
