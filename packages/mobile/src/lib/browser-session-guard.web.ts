import {
  captureAuthCredentialGeneration,
  captureConfirmedWebAuthIdentity,
  isAuthCredentialGenerationCurrent,
} from './auth-store.web';
import { isBrowserPageRetired } from './browser-page-retirement.web';
import { admitBrowserResponse } from './browser-response-admission.web';

/**
 * The browser session changed between sending a request and using its answer.
 * The server may well have committed the work for the account that sent it;
 * the caller shows nothing (no toast, no navigation, no cache write). Named
 * `AbortError` so error reporting and cancellation filters already drop it.
 */
export class SessionSupersededError extends Error {
  readonly code = 'superseded';

  constructor(message = 'The browser session changed before this response could be used') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isSessionSupersededError(error: unknown): error is SessionSupersededError {
  return error instanceof SessionSupersededError;
}

/** Who a request was sent as: credential generation plus the confirmed login. */
export type SessionStamp = Readonly<{ generation: number; userId: string | null; authSessionId: string | null }>;

export function captureSessionStamp(generation: number = captureAuthCredentialGeneration()): SessionStamp {
  const identity = captureConfirmedWebAuthIdentity();
  return Object.freeze({
    generation,
    userId: identity?.userId ?? null,
    authSessionId: identity?.authSessionId ?? null,
  });
}

export function isSessionStampCurrent(stamp: SessionStamp): boolean {
  if (isBrowserPageRetired() || !isAuthCredentialGenerationCurrent(stamp.generation)) return false;
  const identity = captureConfirmedWebAuthIdentity();
  return (identity?.userId ?? null) === stamp.userId && (identity?.authSessionId ?? null) === stamp.authSessionId;
}

export function assertBrowserPageLive(): void {
  if (isBrowserPageRetired()) throw new SessionSupersededError('This page belongs to an account that left');
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A locked or already-consumed body cannot change the refusal.
  }
}

/**
 * Hand a response to its caller only while the stamp it was sent under is
 * current, and re-check that on every later body read. A stale response is
 * cancelled and turned into a `SessionSupersededError`.
 */
export async function admitSessionResponse(response: Response, stamp: SessionStamp): Promise<Response> {
  if (!isSessionStampCurrent(stamp)) {
    await discardBody(response);
    throw new SessionSupersededError();
  }
  return admitBrowserResponse(response, () => {
    if (!isSessionStampCurrent(stamp)) throw new SessionSupersededError();
  });
}
