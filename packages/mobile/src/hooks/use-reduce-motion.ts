import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

let reduceMotion = true;
let revision = 0;
const listeners = new Set<() => void>();
let subscriptions: { remove(): void }[] = [];
function publish(enabled: boolean) {
  if (reduceMotion === enabled) return;
  reduceMotion = enabled;
  for (const listener of listeners) listener();
}
function read() {
  const readRevision = ++revision;
  void AccessibilityInfo.isReduceMotionEnabled()
    .then((enabled) => {
      if (readRevision === revision) publish(enabled);
    })
    .catch(() => {});
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    subscriptions = [
      AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
        revision++;
        publish(enabled);
      }),
      AppState.addEventListener('change', (state) => {
        if (state === 'active') read();
      }),
    ];
    read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      revision++;
      for (const subscription of subscriptions) subscription.remove();
      subscriptions = [];
      // A newly mounted screen must be conservative until its fresh read settles.
      reduceMotion = true;
    }
  };
}
/** One OS subscription for every pressable/list row; unknown settings never animate. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reduceMotion,
    () => true,
  );
}
