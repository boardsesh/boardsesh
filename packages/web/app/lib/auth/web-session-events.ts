'use client';

import { getSession, signIn, type SignInOptions, type SignInResponse } from 'next-auth/react';
import { browserSessionGuard } from './session-guard';

// A legacy-only browser must complete the session read before retrying a canonical action.
export async function bridgeLegacyBrowserSession(): Promise<void> {
  await getSession();
}

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
  provider: 'credentials' | 'apple' | 'google',
  options?: SignInOptions,
  /** Sent to the provider, as NextAuth's third `signIn` argument (the forced Google re-sign-in, #7655). */
  authorizationParams?: Readonly<Record<string, string>>,
): Promise<SignInResponse | undefined> {
  const epoch = beginWebSessionIntent();
  // This tab's own sign-in: the guard drops older responses but keeps the page.
  const localChange = browserSessionGuard().expectLocalChange();
  let signedIn = false;
  try {
    const result = await (authorizationParams
      ? signIn(provider, options, { ...authorizationParams })
      : signIn(provider, options));
    signedIn = !result?.error;
    return result;
  } finally {
    // A failed sign-in changed nothing here, so a change read now came from elsewhere.
    if (signedIn) localChange.extend();
    else localChange.cancel();
    requestWebSessionRefresh(epoch);
    // Public notification for already-open NextAuth pages. Its result is never
    // accepted as identity by the owned provider.
    if (epoch === captureWebSessionEpoch()) void getSession().catch(() => {});
  }
}
