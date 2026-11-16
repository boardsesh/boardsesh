'use client';

import { getSession, signIn, type SignInOptions, type SignInResponse } from 'next-auth/react';
import { z } from 'zod';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { publicBrowserPasswordReady } from './browser-password-readiness';
import { canonicalPasswordOptionsSchema, signInCanonicalPassword } from './canonical-password-signin';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { readCanonicalBrowserCoordinator, signInCanonicalBrowserCoordinator } from './browser-coordinator-client';
import { getCanonicalBrowserOrigin } from './canonical-browser-origin';
import { startCanonicalProviderSignin } from './canonical-provider-start';
import { browserSessionGuard } from './session-guard';

export const WEB_SESSION_REFRESH_EVENT = 'boardsesh-web-session-refresh';
const EPOCH_KEY = Symbol.for('boardsesh.web-session-intent.epoch-v1');
const refreshedViewRevisions = new WeakMap<object, number>();
const providerOptions = z
  .object({
    callbackUrl: z.string().max(4096).optional(),
    redirect: z.boolean().optional(),
    providerSecurityOperation: z.enum(['link', 'reauthenticate-google']).optional(),
    providerSecurityOperationKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
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

/** Several private islands may observe one retirement. Request one primary
 * read for that actual Session object/revision, without inventing a new intent. */
export function requestWebSessionRefreshForView(session: object, revision: number): void {
  if (refreshedViewRevisions.get(session) === revision) return;
  refreshedViewRevisions.set(session, revision);
  requestWebSessionRefresh();
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
  const passwordReady = publicBrowserPasswordReady();
  let signedIn = false;
  try {
    const result = await signInThroughReadyPath(provider, options, context, {
      coordinatorReady,
      providerReady,
      passwordReady,
    });
    signedIn = !result?.error;
    return result;
  } finally {
    // A failed sign-in changed nothing here, so a change read now came from elsewhere.
    if (signedIn) localChange.extend();
    else localChange.cancel();
    requestWebSessionRefresh(epoch);
    // Public notification for already-open NextAuth pages. Its result is never
    // accepted as identity by the owned provider.
    if (!coordinatorReady && !providerReady && !passwordReady && epoch === captureWebSessionEpoch())
      void getSession().catch(() => {});
  }
}

type SignInReadiness = {
  readonly coordinatorReady: boolean;
  readonly providerReady: boolean;
  readonly passwordReady: boolean;
};

async function signInThroughReadyPath(
  provider: 'credentials' | 'apple' | 'google',
  options: SignInOptions | undefined,
  context: { readonly signal?: AbortSignal } | undefined,
  { coordinatorReady, providerReady, passwordReady }: SignInReadiness,
): Promise<SignInResponse | undefined> {
  const selectedProvider = provider !== 'credentials' && (coordinatorReady || providerReady);
  if (provider === 'credentials' && (coordinatorReady || providerReady || passwordReady)) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    try {
      const origin = getCanonicalBrowserOrigin();
      if (!coordinatorReady || !passwordReady || !origin || typeof window === 'undefined')
        throw new Error('PASSWORD_SIGNIN_UNAVAILABLE');
      const parsed = canonicalPasswordOptionsSchema.parse(options ?? {});
      return await signInCanonicalPassword(
        {
          canonicalOrigin: origin,
          email: parsed.email,
          password: parsed.password,
          callbackUrl: parsed.callbackUrl ?? '/',
          redirect: parsed.redirect ?? true,
          signal: controller.signal,
        },
        {
          currentOrigin: window.location.origin,
          locks: navigator.locks,
          preflight: signInCanonicalBrowserCoordinator,
          send: fetch,
          navigate: (destination) => window.location.assign(destination),
        },
      );
    } catch {
      return { error: AUTH_BACKEND_UNAVAILABLE, status: 503, ok: false, url: null };
    } finally {
      clearTimeout(timeout);
      context?.signal?.removeEventListener('abort', abort);
    }
  }
  if (selectedProvider) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const origin = getCanonicalBrowserOrigin();
      if (!coordinatorReady || !providerReady || !origin || typeof window === 'undefined')
        throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
      const parsed = providerOptions.parse(options ?? {});
      if ((parsed.providerSecurityOperation === undefined) !== (parsed.providerSecurityOperationKey === undefined))
        throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
      await startCanonicalProviderSignin(
        {
          canonicalOrigin: origin,
          provider,
          callbackUrl: parsed.callbackUrl ?? '/',
          signal: controller.signal,
          ...(parsed.providerSecurityOperation && parsed.providerSecurityOperationKey
            ? {
                operation: {
                  purpose: parsed.providerSecurityOperation,
                  operationKey: parsed.providerSecurityOperationKey,
                },
              }
            : {}),
        },
        {
          currentOrigin: window.location.origin,
          locks: navigator.locks,
          preflight: parsed.providerSecurityOperation
            ? readCanonicalBrowserCoordinator
            : signInCanonicalBrowserCoordinator,
          send: fetch,
          navigate: (destination) => window.location.assign(destination),
        },
      );
      return undefined;
    } catch {
      return { error: AUTH_BACKEND_UNAVAILABLE, status: 503, ok: false, url: null };
    } finally {
      clearTimeout(timeout);
      context?.signal?.removeEventListener('abort', abort);
    }
  }
  return await signIn(provider, options);
}
