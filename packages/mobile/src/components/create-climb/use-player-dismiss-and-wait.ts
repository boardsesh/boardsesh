import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';

type NativeStackTransitionEndEvent = {
  data?: {
    closing?: boolean;
  };
};

type NativeStackTransitionNavigation = {
  addListener: (event: 'transitionEnd', listener: (transition: NativeStackTransitionEndEvent) => void) => () => void;
};

const DISMISSED_RESULT: DismissAndWaitResult = { status: 'dismissed' };
const ABORTED_RESULT: DismissAndWaitResult = { status: 'aborted' };
// Native-stack modal closes normally finish well inside this window. The timer
// is only a fail-safe for a missing transitionEnd event, so keep it comfortably
// beyond the usual animation rather than risking an overlapping presentation.
const PLAYER_DISMISS_CEILING_MS = 800;

/**
 * `/play`-owned dismissal callback for the create-climb handoff.
 *
 * The hook must be mounted inside the actual player route so `useNavigation()`
 * resolves the native-stack screen navigation object. It subscribes before the
 * dismiss request and waits specifically for the closing transition to end.
 * Expo web does not emit that native event, so it dismisses and resolves in the
 * same turn. A bounded ceiling handles a lost native event; route teardown
 * aborts any outstanding waiter and removes its listener.
 */
export function usePlayerDismissAndWait(): () => Promise<DismissAndWaitResult> {
  const router = useRouter();
  const navigation = useNavigation() as unknown as NativeStackTransitionNavigation;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const pendingAbortsRef = useRef(new Set<() => void>());

  useEffect(
    () => () => {
      for (const abort of pendingAbortsRef.current) abort();
    },
    [],
  );

  return useCallback(() => {
    if (Platform.OS === 'web') {
      try {
        router.dismiss();
        return Promise.resolve(DISMISSED_RESULT);
      } catch {
        return Promise.resolve(ABORTED_RESULT);
      }
    }

    return new Promise<DismissAndWaitResult>((resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
      let finish = (_result: DismissAndWaitResult) => {};
      const abort = () => finish(ABORTED_RESULT);

      finish = (result: DismissAndWaitResult) => {
        if (finished) return;
        finished = true;
        pendingAbortsRef.current.delete(abort);
        if (ceilingTimer !== null) clearTimeout(ceilingTimer);
        unsubscribe();
        resolve(result);
      };
      pendingAbortsRef.current.add(abort);

      try {
        // Register first: a fast native transition must not finish in the gap
        // between router.dismiss() and listener attachment.
        unsubscribe = navigationRef.current.addListener('transitionEnd', (transition) => {
          if (transition.data?.closing !== true) return;
          finish(DISMISSED_RESULT);
        });
        ceilingTimer = setTimeout(() => finish(DISMISSED_RESULT), PLAYER_DISMISS_CEILING_MS);
        router.dismiss();
      } catch {
        finish(ABORTED_RESULT);
      }
    });
  }, [router]);
}
