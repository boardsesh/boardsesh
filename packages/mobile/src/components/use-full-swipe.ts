import { useCallback, useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { fullSwipeDirection, type SwipeDirection } from './swipe-action-model';

/** Measure the finger's release distance, before Swipeable springs to its reveal
 * width. Only the release crosses to JS; no per-frame state updates. */
export function useFullSwipe({
  scope,
  enabled,
  onCommit,
  close,
}: {
  scope: string;
  enabled: boolean;
  onCommit: (direction: SwipeDirection) => void;
  close: () => void;
}) {
  const latest = useRef({ scope, enabled, onCommit, close });
  latest.current = { scope, enabled, onCommit, close };
  const committed = useRef<string | null>(null);
  const opened = useRef<string | null>(null);
  const reset = useCallback((originScope: string) => {
    if (originScope !== latest.current.scope) return;
    committed.current = null;
    opened.current = null;
  }, []);
  const commit = useCallback((direction: SwipeDirection, originScope: string) => {
    if (committed.current || !latest.current.enabled || originScope !== latest.current.scope) return;
    committed.current = originScope;
    latest.current.onCommit(direction);
    // Reduce Motion can settle the open animation before this JS release call.
    if (opened.current === originScope) latest.current.close();
  }, []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-10, 10])
        .failOffsetY([-14, 14])
        .onStart(() => {
          runOnJS(reset)(scope);
        })
        .onEnd((event, success) => {
          if (success === false) return;
          const direction = fullSwipeDirection(event.translationX);
          if (direction) runOnJS(commit)(direction, scope);
        }),
    [enabled, scope, reset, commit],
  );
  const onOpened = useCallback(() => {
    if (scope !== latest.current.scope) return;
    opened.current = scope;
    if (committed.current === scope) latest.current.close();
  }, [scope]);
  const onClosed = useCallback(() => reset(scope), [scope, reset]);
  return { gesture, onOpened, onClosed };
}
