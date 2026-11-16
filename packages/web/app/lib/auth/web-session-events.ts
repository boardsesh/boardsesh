'use client';

import { getSession, signIn, type SignInOptions, type SignInResponse } from 'next-auth/react';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { browserSessionGuard } from './session-guard';

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
  context?: { readonly signal?: AbortSignal },
): Promise<SignInResponse | undefined> {
  const epoch = beginWebSessionIntent();
  // This tab's own sign-in: the guard drops older responses but keeps the page.
  const localChange = browserSessionGuard().expectLocalChange();
  const coordinatorReady = publicBrowserCoordinatorReady();
  const providerReady = publicProviderSecurityReady();
  let signedIn = false;
  try {
    const result = await signInThroughReadyPath(provider, options, context, { coordinatorReady, providerReady });
    signedIn = !result?.error;
    return result;
  } finally {
    // A failed sign-in changed nothing here, so a change read now came from elsewhere.
    if (signedIn) localChange.extend();
    else localChange.cancel();
    requestWebSessionRefresh(epoch);
    // Public notification for already-open NextAuth pages. Its result is never
    // accepted as identity by the owned provider.
    if (!coordinatorReady && !providerReady && epoch === captureWebSessionEpoch()) void getSession().catch(() => {});
  }
}

type SignInReadiness = {
  readonly coordinatorReady: boolean;
  readonly providerReady: boolean;
};

async function signInThroughReadyPath(
  provider: 'credentials' | 'apple' | 'google',
  options: SignInOptions | undefined,
  context: { readonly signal?: AbortSignal } | undefined,
  { coordinatorReady, providerReady }: SignInReadiness,
): Promise<SignInResponse | undefined> {
  // #7596 removed the selected password writer and the selected Google/Apple
  // start. While a gate is on, a legacy sign-in would write a NextAuth cookie
  // the selected reader ignores, and metadata preflight cannot authorize it.
  if (coordinatorReady || providerReady) return { error: AUTH_BACKEND_UNAVAILABLE, status: 503, ok: false, url: null };
  return await signIn(provider, options);
}
