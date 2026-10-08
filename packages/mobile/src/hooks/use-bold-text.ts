import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Platform } from 'react-native';

let boldText = false;
let revision = 0;
const listeners = new Set<() => void>();
let subscriptions: { remove(): void }[] = [];

function publish(enabled: boolean) {
  if (boldText === enabled) return;
  boldText = enabled;
  for (const listener of listeners) listener();
}

function read() {
  if (Platform.OS !== 'ios' || !AccessibilityInfo?.isBoldTextEnabled) return;
  const readRevision = ++revision;
  void AccessibilityInfo.isBoldTextEnabled()
    .then((enabled) => {
      if (readRevision === revision) publish(enabled);
    })
    .catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && Platform.OS === 'ios') {
    if (AccessibilityInfo?.addEventListener) {
      subscriptions.push(
        AccessibilityInfo.addEventListener('boldTextChanged', (enabled) => {
          revision++;
          publish(enabled);
        }),
      );
    }
    if (AppState?.addEventListener) {
      subscriptions.push(
        AppState.addEventListener('change', (state) => {
          if (state === 'active') read();
        }),
      );
    }
    read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      revision++;
      for (const subscription of subscriptions) subscription.remove();
      subscriptions = [];
    }
  };
}

/** One native subscription shared by all text; foreground reads survive suspension. */
export function useBoldText(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => boldText,
    () => false,
  );
}
