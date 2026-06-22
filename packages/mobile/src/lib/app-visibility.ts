import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

/**
 * Single source of truth for "is the app backgrounded", consumed via
 * `useIsAppBackgrounded()`. The AppState listener is installed lazily on the
 * first subscribe and removed on the last unsubscribe (ref-counted) — not at
 * module load — so Fast Refresh re-evaluating this module can't accumulate
 * orphan listeners, and there's still only ONE AppState listener regardless of
 * how many climb-image instances subscribe.
 *
 * Only `background` flips the flag (not the transient iOS `inactive`), so a
 * notification-shade pull or app-switcher peek doesn't blank-then-reload the UI.
 * See `useImageCacheMemoryManagement` + LayeredClimbImage for the consumers.
 */

let backgrounded = false;
const listeners = new Set<() => void>();
let subscription: NativeEventSubscription | null = null;

function setBackgrounded(next: boolean): void {
  if (next === backgrounded) return;
  backgrounded = next;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  if (listeners.size === 0) {
    // try/catch (not just optional-chaining): some unit-test RN mocks omit
    // AppState, and vitest throws on accessing an undefined named export. In
    // production AppState is always present, so this only guards partial mocks.
    try {
      if (AppState?.currentState != null) backgrounded = AppState.currentState === 'background';
      subscription = AppState?.addEventListener?.('change', (state) => setBackgrounded(state === 'background')) ?? null;
    } catch {
      // Keep the flag + subscription consistent if currentState read but
      // addEventListener threw (partial mock).
      backgrounded = false;
      subscription = null;
    }
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

function getSnapshot(): boolean {
  return backgrounded;
}

export function useIsAppBackgrounded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
