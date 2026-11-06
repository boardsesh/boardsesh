'use client';

import { getSession, signIn, type SignInOptions, type SignInResponse } from 'next-auth/react';

export const WEB_SESSION_REFRESH_EVENT = 'boardsesh-web-session-refresh';
const EPOCH_KEY = Symbol.for('boardsesh.web-session-intent.epoch-v1');
type EpochGlobal = typeof globalThis & { [key: symbol]: { epoch: number } | undefined };

function epochState(): { epoch: number } {
  const shared = globalThis as EpochGlobal;
  return (shared[EPOCH_KEY] ??= { epoch: 0 });
}

export function captureWebSessionEpoch(): number {
  return epochState().epoch;
}

export function beginWebSessionIntent(): number {
  return ++epochState().epoch;
}

export function requestWebSessionRefresh(expectedEpoch?: number): void {
  if (expectedEpoch !== undefined && expectedEpoch !== captureWebSessionEpoch()) return;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WEB_SESSION_REFRESH_EVENT));
}

/** Own the intent before the public client starts any asynchronous work. */
export async function signInWithSessionIntent(
  provider: 'credentials' | 'apple' | 'google' | 'facebook',
  options?: SignInOptions,
): Promise<SignInResponse | undefined> {
  const epoch = beginWebSessionIntent();
  try {
    return await signIn(provider, options);
  } finally {
    requestWebSessionRefresh(epoch);
    // Public notification for already-open NextAuth pages. Its result is never
    // accepted as identity by the owned provider.
    if (epoch === captureWebSessionEpoch()) void getSession().catch(() => {});
  }
}
