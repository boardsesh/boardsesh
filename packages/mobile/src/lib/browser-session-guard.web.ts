import { captureConfirmedWebAuthIdentity } from './auth-store.web';
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

/** Which login a request was sent as. A cold or anonymous page has neither id. */
export type SessionStamp = Readonly<{ userId: string | null; authSessionId: string | null }>;

export function captureSessionStamp(): SessionStamp {
  const identity = captureConfirmedWebAuthIdentity();
  return Object.freeze({ userId: identity?.userId ?? null, authSessionId: identity?.authSessionId ?? null });
}

/**
 * An answer is delivered only while its page is live and still has the login
 * it was sent as. The credential generation fences sends, not answers: a bump
 * with the same login (another tab's rotation hint, a sign-out that has only
 * started) is not an account change, so its answers still arrive and their
 * callers do not show an error for work the server did. A real change of
 * login retires the page (or, from signed out, changes the stamp) first.
 */
export function isSessionStampCurrent(stamp: SessionStamp): boolean {
  if (isBrowserPageRetired()) return false;
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
