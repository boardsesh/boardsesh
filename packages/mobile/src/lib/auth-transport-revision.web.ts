import { useSyncExternalStore } from 'react';

let revision = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return revision;
}

/** Restart transport-owning effects after an in-memory browser credential changes. */
export function bumpAuthTransportRevision(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function useAuthTransportRevision(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
