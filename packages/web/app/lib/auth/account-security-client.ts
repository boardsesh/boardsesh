'use client';

import { bridgeLegacyBrowserSession } from './web-session-events';
import { browserSessionGuard, guardedFetch } from './session-guard';

/**
 * The browser side of www's provider-security and first-password routes
 * (#7596 B5e2). Every call goes through the www session guard, which adds the
 * expected-viewer header. A browser that still holds only the legacy cookie
 * gets `canonical_session_required`: the session read bridges it, and the
 * call is sent once more.
 */

export type AccountSecurityAnswer = { httpStatus: number; body: Record<string, unknown> };

/** The reply's `status` field (`methods`, `committed`, `redirect`, `refused`, …), or `unavailable`. */
export function answerStatus(answer: AccountSecurityAnswer): string {
  return typeof answer.body.status === 'string' ? answer.body.status : 'unavailable';
}

/** A refusal's code (or outcome when it has no telling code), for the copy. */
export function refusalOf(answer: AccountSecurityAnswer): { outcome: string; code: string } | undefined {
  const { outcome, code } = answer.body;
  return answerStatus(answer) === 'refused' && typeof outcome === 'string' && typeof code === 'string'
    ? { outcome, code }
    : undefined;
}

/**
 * How long a call waits for the page's first accepted session read. Before it
 * the guard names nobody, and these routes refuse a call without the
 * expected-viewer header: the emailed first-password link opens a new tab whose
 * status check ran before that read and always showed "try again".
 */
export const ACCOUNT_SECURITY_VIEWER_WAIT_MS = 10_000;

async function send(path: string, init: RequestInit): Promise<AccountSecurityAnswer> {
  await browserSessionGuard().whenViewerKnown(ACCOUNT_SECURITY_VIEWER_WAIT_MS);
  const response = await guardedFetch(path, { ...init, cache: 'no-store' });
  const parsed: unknown = await response.json().catch(() => undefined);
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { httpStatus: response.status, body };
}

async function withBridgeRetry(request: () => Promise<AccountSecurityAnswer>): Promise<AccountSecurityAnswer> {
  const first = await request();
  if (first.httpStatus !== 403 || first.body.outcome !== 'canonical_session_required') return first;
  await bridgeLegacyBrowserSession();
  return request();
}

export function readAccountSecurity(path: string): Promise<AccountSecurityAnswer> {
  return withBridgeRetry(() => send(path, { method: 'GET' }));
}

export function postAccountSecurity(path: string, body: Record<string, unknown> = {}): Promise<AccountSecurityAnswer> {
  return withBridgeRetry(() =>
    send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

export const PROVIDER_SECURITY_PATH = '/api/auth/provider-security';
export const FIRST_PASSWORD_PATH = '/api/auth/first-password';
/** The query value a provider round trip comes back with. */
export const PROVIDER_SECURITY_RESULT_PARAM = 'providerSecurity';
