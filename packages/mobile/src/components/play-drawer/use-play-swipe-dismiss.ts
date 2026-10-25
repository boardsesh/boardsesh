import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { springs } from '../../theme/animations';
import type { SwipeDismissAnimation } from './use-drawer-dismiss-gesture';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';

/** Route-local motion: native open/button close, continuous UI-thread swipe close. */
export function usePlaySwipeDismiss(openTargetNonce?: number | null) {
  const navigation = useNavigation();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const translateY = useSharedValue(0);
  const height = useSharedValue(windowHeight);
  const isDismissing = useSharedValue(false);
  const dismissRevision = useSharedValue(0);
  const openingRef = useRef({ nonce: openTargetNonce, revision: 0 });
  if (openTargetNonce != null && openTargetNonce !== openingRef.current.nonce)
    openingRef.current = { nonce: openTargetNonce, revision: openingRef.current.revision + 1 };
  const openingRevision = openingRef.current.revision;
  const appliedRevisionRef = useRef(openingRevision);
  const mountedRef = useRef(false);
  const removalRequestedRef = useRef(false);
  const nativeRemovalRevisionRef = useRef<number | null>(null);
  const nativeRemovalAttemptRef = useRef(0);
  const requestedRemovalRef = useRef<{ attempt: number; removalEventSeen: boolean } | null>(null);
  const [offscreenRevision, setOffscreenRevision] = useState<number | null>(null);
  const [restorationVersion, setRestorationVersion] = useState(0);
  const appliedRestorationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onRemoval = (event: { defaultPrevented: boolean }) => {
      if (!mountedRef.current) return;
      const removingRevision = nativeRemovalRevisionRef.current ?? openingRef.current.revision;
      nativeRemovalRevisionRef.current = removingRevision;
      const requestedRemoval = requestedRemovalRef.current;
      let removingAttempt: number;
      if (requestedRemoval?.attempt === nativeRemovalAttemptRef.current && !requestedRemoval.removalEventSeen) {
        // The first native event belongs to the close we just requested. Keep
        // its waiter able to restore an aborted request after this event.
        requestedRemoval.removalEventSeen = true;
        removingAttempt = requestedRemoval.attempt;
      } else {
        // Another event is a distinct removal, even for the same opener.
        removingAttempt = ++nativeRemovalAttemptRef.current;
        requestedRemovalRef.current = null;
      }
      // A later listener can prevent this action (for example an unsaved draft).
      // Wait until all synchronous listeners ran before restoring a blocked close.
      queueMicrotask(() => {
        if (
          mountedRef.current &&
          event.defaultPrevented &&
          nativeRemovalRevisionRef.current === removingRevision &&
          nativeRemovalAttemptRef.current === removingAttempt
        ) {
          nativeRemovalRevisionRef.current = null;
          requestedRemovalRef.current = null;
          // Restoring this same opener begins a new motion lifetime too. An old
          // completion already queued on JS must not close the restored surface.
          openingRef.current = { ...openingRef.current, revision: openingRef.current.revision + 1 };
          setRestorationVersion((version) => version + 1);
        }
      });
    };
    const unsubscribeBlocked = navigation.addListener('removePrevented', () => onRemoval({ defaultPrevented: true }));
    const unsubscribeRemoved = navigation.addListener('removed', () => onRemoval({ defaultPrevented: false }));
    return () => {
      // Blocked removal can restore state only while mounted. `removed` is
      // delivered after unmount, so retain that observer through this task.
      unsubscribeBlocked();
      queueMicrotask(unsubscribeRemoved);
    };
  }, [navigation]);

  useLayoutEffect(() => {
    if (appliedRevisionRef.current === openingRevision && appliedRestorationRef.current === restorationVersion) return;
    // A dispatched native pop cannot be canceled here. Leave this opener
    // unconsumed so its own host target replays after the old route unmounts.
    if (nativeRemovalRevisionRef.current != null) return;
    appliedRevisionRef.current = openingRevision;
    appliedRestorationRef.current = restorationVersion;
    removalRequestedRef.current = false;
    setOffscreenRevision(null);
    navigation.setOptions({ animation: 'slide_from_bottom' });
    runOnUI((revision: number) => {
      'worklet';
      dismissRevision.value = revision;
      cancelAnimation(translateY);
      translateY.value = 0;
      isDismissing.value = false;
    })(openingRevision);
  }, [openingRevision, restorationVersion, navigation, dismissRevision, translateY, isDismissing]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      height.value = event.nativeEvent.layout.height;
    },
    [height],
  );

  const onComplete = useCallback(
    (completedRevision = openingRevision) => {
      if (
        !mountedRef.current ||
        completedRevision !== openingRef.current.revision ||
        nativeRemovalRevisionRef.current != null ||
        removalRequestedRef.current
      )
        return;
      removalRequestedRef.current = true;
      setOffscreenRevision(completedRevision);
    },
    [openingRevision],
  );

  useEffect(() => {
    if (offscreenRevision == null || offscreenRevision !== openingRef.current.revision) return;

    // The surface is already offscreen. Commit the option update separately
    // from removal, then give Fabric a frame to apply it to RNSScreen before
    // popping. Never change options and dismiss in the same mounting batch:
    // UIKit could otherwise start a second native slide with the old option.
    navigation.setOptions({ animation: 'none' });
    let frame = requestAnimationFrame(() => {
      if (!mountedRef.current || offscreenRevision !== openingRef.current.revision) return;
      frame = requestAnimationFrame(() => {
        if (
          !mountedRef.current ||
          offscreenRevision !== openingRef.current.revision ||
          nativeRemovalRevisionRef.current != null
        )
          return;
        if (navigation.isFocused()) {
          nativeRemovalRevisionRef.current = offscreenRevision;
          requestedRemovalRef.current = { attempt: ++nativeRemovalAttemptRef.current, removalEventSeen: false };
          router.dismiss();
        } else {
          // A different modal covered /play while JS was busy. Restore this
          // player underneath it instead of popping that newer route.
          navigation.setOptions({ animation: 'slide_from_bottom' });
          translateY.value = withSpring(0, springs.interactive);
          isDismissing.value = false;
          removalRequestedRef.current = false;
          setOffscreenRevision(null);
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [offscreenRevision, openingRevision, navigation, router, translateY, isDismissing]);

  const dismissNative = useCallback(
    (requestedRevision: number) => {
      if (
        !mountedRef.current ||
        requestedRevision !== openingRef.current.revision ||
        nativeRemovalRevisionRef.current != null
      )
        return;
      if (navigation.isFocused()) {
        nativeRemovalRevisionRef.current = requestedRevision;
        requestedRemovalRef.current = { attempt: ++nativeRemovalAttemptRef.current, removalEventSeen: false };
        router.dismiss();
      } else isDismissing.value = false;
    },
    [navigation, router, isDismissing],
  );

  const close = useCallback(() => {
    // A chevron tap retains the native close, but cannot race a released swipe.
    runOnUI(() => {
      'worklet';
      if (isDismissing.value || dismissRevision.value !== openingRevision) return;
      isDismissing.value = true;
      runOnJS(dismissNative)(openingRevision);
    })();
  }, [openingRevision, dismissRevision, isDismissing, dismissNative]);

  const canConsumeTarget = useCallback(
    (nonce: number) => nativeRemovalRevisionRef.current == null && nonce === openingRef.current.nonce,
    [restorationVersion],
  );

  const dismissAndWait = useCallback(
    async (waitForDismiss: () => Promise<DismissAndWaitResult>): Promise<DismissAndWaitResult> => {
      if (
        !mountedRef.current ||
        !navigation.isFocused() ||
        openingRevision !== openingRef.current.revision ||
        nativeRemovalRevisionRef.current != null
      )
        return { status: 'aborted' };
      nativeRemovalRevisionRef.current = openingRevision;
      const removingAttempt = ++nativeRemovalAttemptRef.current;
      requestedRemovalRef.current = { attempt: removingAttempt, removalEventSeen: false };
      const restoreAbortedClose = () => {
        if (
          !mountedRef.current ||
          nativeRemovalRevisionRef.current !== openingRevision ||
          nativeRemovalAttemptRef.current !== removingAttempt
        )
          return;
        nativeRemovalRevisionRef.current = null;
        requestedRemovalRef.current = null;
        openingRef.current = { ...openingRef.current, revision: openingRef.current.revision + 1 };
        setRestorationVersion((version) => version + 1);
      };
      try {
        const result = await waitForDismiss();
        if (result.status === 'aborted') restoreAbortedClose();
        return openingRevision === openingRef.current.revision ? result : { status: 'aborted' };
      } catch (error) {
        restoreAbortedClose();
        throw error;
      }
    },
    [openingRevision, navigation],
  );

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const swipeDismiss = useMemo<SwipeDismissAnimation>(
    () => ({ translateY, height, isDismissing, revision: dismissRevision, onComplete }),
    [translateY, height, isDismissing, dismissRevision, onComplete],
  );

  return { swipeDismiss, animatedStyle, onLayout, close, canConsumeTarget, dismissAndWait };
}
