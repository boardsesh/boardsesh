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
// Match the native-sheet coordinator's conservative ceilings. A player route can
// unmount before react-native-screens delivers transitionEnd, so this is also the
// sole settle signal for that expected teardown path.
const PLAYER_DISMISS_CEILING_MS = Platform.OS === 'ios' ? 550 : 350;

/**
 * `/play`-owned dismissal callback for the create-climb handoff.
 *
 * The hook must be mounted inside the actual player route so `useNavigation()`
 * resolves the native-stack screen navigation object. It subscribes before the
 * dismiss request and waits specifically for the closing transition to end.
 * Expo web does not emit that native event, so it dismisses and resolves in the
 * same turn. A bounded ceiling handles a lost native event. Route teardown
 * before this helper starts a dismiss aborts the waiter; teardown caused by this
 * helper's own dismiss keeps the ceiling alive, because the native event emitter
 * can disappear before react-native-screens emits transitionEnd.
 */
export function usePlayerDismissAndWait(): () => Promise<DismissAndWaitResult> {
  const router = useRouter();
  const navigation = useNavigation() as unknown as NativeStackTransitionNavigation;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const isPlayerMountedRef = useRef(true);
  const pendingRouteUnmountsRef = useRef(new Set<() => void>());

  useEffect(() => {
    isPlayerMountedRef.current = true;
    return () => {
      isPlayerMountedRef.current = false;
      for (const handleRouteUnmount of pendingRouteUnmountsRef.current) handleRouteUnmount();
    };
  }, []);

  return useCallback(() => {
    // The callback is threaded through a root-mounted actions menu. If the
    // player disappeared while an earlier source-sheet wait was settling, do not
    // let its stale callback pop whatever route is now visible underneath.
    if (!isPlayerMountedRef.current) return Promise.resolve(ABORTED_RESULT);

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
      let dismissRequested = false;
      let unsubscribe = () => {};
      let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
      let handleRouteUnmount = () => {};

      const unsubscribeOnce = () => {
        const currentUnsubscribe = unsubscribe;
        unsubscribe = () => {};
        currentUnsubscribe();
      };

      const finish = (result: DismissAndWaitResult) => {
        if (finished) return;
        finished = true;
        pendingRouteUnmountsRef.current.delete(handleRouteUnmount);
        if (ceilingTimer !== null) clearTimeout(ceilingTimer);
        unsubscribeOnce();
        resolve(result);
      };

      handleRouteUnmount = () => {
        if (!dismissRequested) {
          finish(ABORTED_RESULT);
          return;
        }

        // This is the normal result of router.dismiss(): React tears down the
        // player before its native close animation has necessarily reported a
        // transitionEnd. The listener is now attached to a dead screen, but the
        // timer is closure-owned and must remain to keep the next route from
        // presenting over the outgoing player animation.
        unsubscribeOnce();
      };
      pendingRouteUnmountsRef.current.add(handleRouteUnmount);

      try {
        // Register first: a fast native transition must not finish in the gap
        // between router.dismiss() and listener attachment.
        unsubscribe = navigationRef.current.addListener('transitionEnd', (transition) => {
          if (transition.data?.closing !== true) return;
          finish(DISMISSED_RESULT);
        });
        // An unusual synchronous teardown while registering must not continue
        // into router.dismiss() after it has already aborted this waiter.
        if (finished) {
          unsubscribeOnce();
          return;
        }
        ceilingTimer = setTimeout(() => finish(DISMISSED_RESULT), PLAYER_DISMISS_CEILING_MS);
        // Set this before calling router.dismiss(): React can synchronously
        // unmount /play from inside that call, before it returns to this frame.
        dismissRequested = true;
        router.dismiss();
      } catch {
        finish(ABORTED_RESULT);
      }
    });
  }, [router]);
}
