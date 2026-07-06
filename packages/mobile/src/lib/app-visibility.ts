import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

// Single source of truth for "is the app backgrounded", backed by ONE AppState
// listener installed lazily on the first subscriber and removed when the last
// unsubscribes. Tying the listener to React lifecycle (instead of a bare
// module-load side effect) keeps it from accumulating across Fast Refresh
// reloads. Only `background` flips the flag — not iOS `inactive`, a transient
// interruption where a blank-then-reload would just flash.
let backgrounded = false;
const listeners = new Set<() => void>();
let appStateSub: NativeEventSubscription | null = null;

function setBackgrounded(next: boolean): void {
  if (next === backgrounded) return;
  backgrounded = next;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (appStateSub === null) {
    // Seed from the current state so a component mounting while already
    // backgrounded starts with the right flag (usually 'active' at mount).
    backgrounded = AppState.currentState === 'background';
    appStateSub = AppState.addEventListener('change', (state) => {
      setBackgrounded(state === 'background');
    });
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      appStateSub?.remove();
      appStateSub = null;
    }
  };
}

function getSnapshot(): boolean {
  return backgrounded;
}

export function useIsAppBackgrounded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
