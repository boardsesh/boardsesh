'use client';

import { getSession, signIn, type SignInOptions, type SignInResponse } from 'next-auth/react';
import { z } from 'zod';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { readCanonicalBrowserCoordinator } from './browser-coordinator-client';
import { getCanonicalBrowserOrigin } from './canonical-browser-origin';
import { startCanonicalProviderSignin } from './canonical-provider-start';

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
  const coordinatorReady = publicBrowserCoordinatorReady();
  const providerReady = publicProviderSecurityReady();
  const selectedProvider = provider !== 'credentials' && (coordinatorReady || providerReady);
  try {
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
            preflight: readCanonicalBrowserCoordinator,
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
  } finally {
    requestWebSessionRefresh(epoch);
    // Public notification for already-open NextAuth pages. Its result is never
    // accepted as identity by the owned provider.
    if (!selectedProvider && epoch === captureWebSessionEpoch()) void getSession().catch(() => {});
  }
}
