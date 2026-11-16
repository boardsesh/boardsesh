'use client';

import { useSyncExternalStore } from 'react';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';

const subscribe = (listener: () => void) => browserSessionGuard().subscribe(listener);
const readGeneration = () => browserSessionGuard().capture();
const serverGeneration = () => 0;

/**
 * The session generation this render belongs to. A toast or navigation bound
 * to it is dropped once the account changes (see app/lib/auth/session-guard.ts).
 */
export function useSessionGeneration(): number {
  return useSyncExternalStore(subscribe, readGeneration, serverGeneration);
}

/** True while `generation` is still the page's account and the page is not retiring. */
export function isSessionGenerationCurrent(generation: number): boolean {
  return browserSessionGuard().isCurrent(generation);
}
