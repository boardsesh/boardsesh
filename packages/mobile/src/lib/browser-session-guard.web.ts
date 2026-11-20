import {
  captureConfirmedWebAuthIdentity,
  captureExpectedViewerMarker,
  synchronizeWebSession,
  viewerMarkerSeenAtConfirmation,
} from './auth-store.web';
import { isBrowserPageRetired } from './browser-page-retirement.web';
import { admitBrowserResponse } from './browser-response-admission.web';
import { readViewerMarker } from './viewer-marker.web';

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

/** False marker values one document checks; the next one turns the marker check off for it. */
const MARKER_FALSE_VALUE_LIMIT = 4;
/** The value a page that saw its own marker reads once the cookie is gone (a sign-out on another host). */
const ABSENT_MARKER = '';
/** What an armed page reads when the browser holds two differing copies (another Path or scope). */
const CONFLICTED_MARKER = '\u0000conflicted';
/** A check that proved nothing is tried again on a later reply, after 30 s, then 60 s, up to 5 minutes. */
const UNPROVEN_RETRY_MS = 30_000;
const UNPROVEN_RETRY_MAX_MS = 5 * 60_000;

type FalseMarkerOutcome = 'same-login' | 'unproven';
type CheckedFalseMarker = { readonly outcome: FalseMarkerOutcome; readonly retryAt: number; readonly attempts: number };

/**
 * This document's viewer-marker state (#7596 decision): per login, whether the
 * page saw its own marker (nothing is checked before: only a server under
 * `better-auth` writes one, so with the mode off a planted marker is ignored),
 * and what each false value's last check found; for the document, how many
 * checks it ran and whether the check is off.
 */
const markerState = {
  authSessionId: null as string | null,
  seen: false,
  outcomes: new Map<string, CheckedFalseMarker>(),
  running: new Map<string, Promise<FalseMarkerOutcome | 'other'>>(),
  checks: 0,
  off: false,
};

function markerStateFor(authSessionId: string): typeof markerState {
  if (markerState.authSessionId !== authSessionId) {
    markerState.authSessionId = authSessionId;
    markerState.seen = false;
    markerState.outcomes.clear();
    markerState.running.clear();
  }
  return markerState;
}

/** The false marker value the browser holds for a reply sent under `stamp`, or undefined when nothing is wrong or known. */
function falseMarkerFor(stamp: SessionStamp): string | undefined {
  if (markerState.off || stamp.authSessionId === null || typeof document === 'undefined') return undefined;
  const expected = captureExpectedViewerMarker();
  if (expected === undefined) return undefined;
  const state = markerStateFor(stamp.authSessionId);
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  const reading = readViewerMarker(document.cookie, secure);
  if (reading.kind === 'present' && reading.value === expected) {
    state.seen = true;
    return undefined;
  }
  if (!state.seen && viewerMarkerSeenAtConfirmation()) state.seen = true;
  // Not armed: this document never saw its own marker. Ignore any value.
  if (!state.seen) return undefined;
  // Armed: two differing copies are one false value; a missing marker is a sign-out on another host.
  if (reading.kind === 'conflicted') return CONFLICTED_MARKER;
  if (reading.kind === 'missing') return ABSENT_MARKER;
  return reading.value;
}

/** One shared session read for a false value: another login, the same login confirmed, or nothing proven. */
function checkFalseMarker(value: string, stamp: SessionStamp): Promise<FalseMarkerOutcome | 'other'> {
  const running = markerState.running.get(value);
  if (running) return running;
  markerState.checks += 1;
  const check = synchronizeWebSession()
    .catch(() => undefined)
    .then((result): FalseMarkerOutcome | 'other' => {
      if (markerState.running.get(value) === check) markerState.running.delete(value);
      if (!isSessionStampCurrent(stamp)) return 'other';
      const outcome: FalseMarkerOutcome =
        result?.status === 'authenticated' &&
        result.userId === stamp.userId &&
        result.authSessionId === stamp.authSessionId
          ? 'same-login'
          : 'unproven';
      const attempts = (markerState.outcomes.get(value)?.attempts ?? 0) + 1;
      const backoff = Math.min(UNPROVEN_RETRY_MS * 2 ** (attempts - 1), UNPROVEN_RETRY_MAX_MS);
      markerState.outcomes.set(value, { outcome, attempts, retryAt: Date.now() + backoff });
      return outcome;
    });
  markerState.running.set(value, check);
  return check;
}

/**
 * Whether the viewer marker lets a reply land. A match, any marker before the
 * page saw its own, a value confirmed as the same login, or one whose check
 * proved nothing and is not due again yet: yes. A new false value (two
 * differing copies count as one) is held for the shared session read: another
 * account retires the page and the reply is superseded; the same login
 * confirmed delivers it; a read that proved nothing supersedes it and is tried
 * again on a later reply after a backoff. The marker alone never signs out.
 */
async function viewerMarkerAdmits(stamp: SessionStamp): Promise<boolean> {
  const value = falseMarkerFor(stamp);
  if (value === undefined) return true;
  const checked = markerState.outcomes.get(value);
  if (checked && (checked.outcome === 'same-login' || Date.now() < checked.retryAt)) return true;
  if (!markerState.running.has(value) && markerState.checks >= MARKER_FALSE_VALUE_LIMIT) {
    markerState.off = true;
    return true;
  }
  const outcome = await checkFalseMarker(value, stamp);
  return outcome === 'same-login' && isSessionStampCurrent(stamp);
}

/**
 * Hand a response to its caller only while the stamp it was sent under is
 * current and the browser's viewer marker does not name another login, and
 * re-check the stamp on every later body read. A stale response is cancelled
 * and turned into a `SessionSupersededError`.
 */
export async function admitSessionResponse(response: Response, stamp: SessionStamp): Promise<Response> {
  if (!isSessionStampCurrent(stamp) || !(await viewerMarkerAdmits(stamp))) {
    await discardBody(response);
    throw new SessionSupersededError();
  }
  return admitBrowserResponse(
    response,
    () => {
      if (!isSessionStampCurrent(stamp)) throw new SessionSupersededError();
    },
    async () => {
      // The browser may have switched accounts after fetch received the headers.
      if (!(await viewerMarkerAdmits(stamp))) throw new SessionSupersededError();
    },
  );
}
