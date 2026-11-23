import { useSyncExternalStore } from 'react';

const MOUSE_QUERY = '(any-hover: hover) and (any-pointer: fine)';
let mediaQuery: MediaQueryList | null = null;

function browserMouseQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  mediaQuery ??= window.matchMedia(MOUSE_QUERY);
  return mediaQuery;
}

/** Available input, including a mouse attached to a touch-primary device. */
export function getBrowserMouseAvailable(): boolean {
  return browserMouseQuery()?.matches ?? false;
}

export function subscribeBrowserMouseAvailable(listener: () => void): () => void {
  const query = browserMouseQuery();
  query?.addEventListener?.('change', listener);
  return () => query?.removeEventListener?.('change', listener);
}

const serverSnapshot = (): boolean => false;

export function useBrowserMouseAvailable(): boolean {
  return useSyncExternalStore(subscribeBrowserMouseAvailable, getBrowserMouseAvailable, serverSnapshot);
}
