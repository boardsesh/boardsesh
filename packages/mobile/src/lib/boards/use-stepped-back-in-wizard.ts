// Back (the chevron, a swipe, Android Back) from one add-a-board wizard screen
// to the wizard step under it is not leaving the flow: the climber is still in
// it, one step earlier. Only that screen leaves the stack, and React
// Navigation says so once it is gone (`removed`, with the action that popped
// it and the stack without it). Closing the whole modal tears the boards stack
// down instead: the screen is still in that stack's state, so it is not a
// step back.
//
// `removed` comes after the screen's effects have cleaned up, so the report a
// screen sends on leaving waits a tick (`reportUnlessSteppedBack`) and is
// dropped when the screen turned out to be a step back. The step under it
// reports if the climber leaves from there.

import { useCallback, useEffect, useRef } from 'react';
import { useNavigation, type NativeStackNavigationProp } from 'expo-router';

/** Routes of the boards stack that are wizard steps (the builder counts too, when the wizard opened it). */
export function isWizardStepRoute(routeName: string | undefined): boolean {
  return routeName !== undefined && (routeName.startsWith('add/') || routeName === 'create');
}

type RemoveAction = { type: string; payload?: object };
type StackState = { index: number; routes: readonly { key: string; name: string }[] } | undefined;

/** Whether a removal is one screen going back, not a dismissal of several at once. */
export function isSingleStepBack(action: RemoveAction | undefined): boolean {
  if (!action) return false;
  if (action.type === 'GO_BACK') return true;
  if (action.type !== 'POP') return false;
  const count = (action.payload as { count?: number } | undefined)?.count;
  return count === undefined || count === 1;
}

/**
 * Whether the screen `removedKey` was popped back onto a wizard step: it is
 * gone from the stack (not torn down with it), one screen went, and the screen
 * now on top is a wizard step.
 */
export function steppedBackOntoWizardStep(
  state: StackState,
  removedKey: string | undefined,
  action: RemoveAction | undefined,
): boolean {
  if (!state || !removedKey) return false;
  if (state.routes.some((route) => route.key === removedKey)) return false;
  return isSingleStepBack(action) && isWizardStepRoute(state.routes[state.index]?.name);
}

/** Call from an unmount cleanup: runs `report` a tick later unless the screen was a step back. */
export type ReportUnlessSteppedBack = (report: () => void) => void;

export function useSteppedBackInWizard(): ReportUnlessSteppedBack {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  const steppedBackRef = useRef(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    unsubscribeRef.current = navigation.addListener('removed', (event) => {
      steppedBackRef.current = steppedBackOntoWizardStep(navigation.getState(), event.target, event.data.action);
    });
    // Unsubscribed by the deferred report below, after `removed` has had its
    // say; a screen that never reports unsubscribes on its own tick.
    return () => {
      const unsubscribe = unsubscribeRef.current;
      setTimeout(() => unsubscribe?.(), 0);
    };
  }, [navigation]);
  return useCallback((report: () => void) => {
    setTimeout(() => {
      if (!steppedBackRef.current) report();
    }, 0);
  }, []);
}
