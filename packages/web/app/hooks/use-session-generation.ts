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

/**
 * Runs `action` while `generation` is still the page's account: at once, or,
 * while a false viewer marker is being checked, once the check confirms the
 * same login (never when it names another account or proves nothing).
 */
export function runIfSessionGenerationCurrent(generation: number, action: () => void): void {
  browserSessionGuard().runIfCurrent(generation, action);
}
