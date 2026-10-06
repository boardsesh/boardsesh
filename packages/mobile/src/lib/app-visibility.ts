import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

// Single source of truth for "is the app backgrounded", backed by ONE AppState
// listener installed lazily on the first subscriber and removed when the last
// unsubscribes. Tying the listener to React lifecycle (instead of a bare
// module-load side effect) keeps it from accumulating across Fast Refresh
// reloads. Only `background` flips the flag — not iOS `inactive`, a transient
// interruption where a blank-then-reload would just flash.
let backgrounded = false;
let active = AppState.currentState === 'active';
const listeners = new Set<() => void>();
let appStateSub: NativeEventSubscription | null = null;

function setVisibility(state: string | null): void {
  const nextBackgrounded = state === 'background';
  const nextActive = state === 'active';
  if (nextBackgrounded === backgrounded && nextActive === active) return;
  backgrounded = nextBackgrounded;
  active = nextActive;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (appStateSub === null) {
    // Seed from the current state so a component mounting while already
    // backgrounded starts with the right flag (usually 'active' at mount).
    backgrounded = AppState.currentState === 'background';
    active = AppState.currentState === 'active';
    appStateSub = AppState.addEventListener('change', (state) => {
      setVisibility(state);
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

function getActiveSnapshot(): boolean {
  return active;
}

/** Strict foreground state for offers that should wait through iOS interruptions. */
export function useIsAppActive(): boolean {
  return useSyncExternalStore(subscribe, getActiveSnapshot, getActiveSnapshot);
}
