import { useSyncExternalStore } from 'react';

let visible = false;
const listeners = new Set<() => void>();

/** The sheet coordinator publishes only presence, including its dismiss animation. */
export function publishSheetVisibility(next: boolean): void {
  if (next === visible) return;
  visible = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): boolean => visible;
const getServerSnapshot = (): boolean => false;
export function useAnySheetVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
