import 'server-only';
import { NextResponse } from 'next/server';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import {
  EXPECTED_VIEWER_HEADER,
  VIEWER_CHANGED_CODE,
  VIEWER_CHANGED_ERROR,
  type ViewerChangedBody,
} from './expected-viewer';
import { sessionViewerKey, signedInViewer } from './session-guard';

/** The fields of the admitted session the comparison reads. */
export type ExpectedViewerSession = {
  readonly user?: { readonly id?: string | null } | null;
  readonly authSessionId?: string | null;
} | null;

/**
 * What a request without the header gets.
 * - `reject`: the route's only callers send it (the www guard). A missing
 *   header from a signed-in cookie answers 409, so an old tab or a hand-made
 *   request cannot write as whoever the cookie names now.
 * - `allow`: the route has callers that cannot send it (the published OpenAPI
 *   document lists it). A missing header is served as today.
 */
export type MissingExpectedViewer = 'reject' | 'allow';

export type ExpectedViewerPolicy = {
  /** Route template for the log line, never the resolved path: `[userId]` stays a placeholder. */
  readonly route: string;
  readonly missing: MissingExpectedViewer;
};

/** Why a request was refused. Logged as is; it never carries an id or the header. */
export type ViewerRefusal = 'header_missing' | 'other_user' | 'other_session' | 'anonymous_cookie' | 'malformed';

const ANONYMOUS_VIEWER = sessionViewerKey(null);

/** The cookie's account in the guard's key format, so both sides compare one string. */
export function admittedViewerKey(session: ExpectedViewerSession): string {
  const userId = session?.user?.id;
  return userId ? sessionViewerKey(signedInViewer(userId, session?.authSessionId)) : ANONYMOUS_VIEWER;
}

function refusalOf(expected: string | null, actual: string, missing: MissingExpectedViewer): ViewerRefusal | null {
  if (expected === null) return missing === 'allow' || actual === ANONYMOUS_VIEWER ? null : 'header_missing';
  if (expected === actual) return null;
  // The tab shows nobody and the cookie names someone.
  if (expected === ANONYMOUS_VIEWER) return 'other_user';
  const separator = expected.indexOf(':');
  if (separator <= 0 || separator === expected.length - 1 || /\s/.test(expected)) return 'malformed';
  if (actual === ANONYMOUS_VIEWER) return 'anonymous_cookie';
  // User ids hold no colon, so the first one ends the user id on both sides.
  return expected.slice(0, separator) === actual.slice(0, actual.indexOf(':')) ? 'other_session' : 'other_user';
}

/**
 * Call right after the session read and before any other read or write. Answers
 * 409 `viewer_changed` when the request names another account than the cookie
 * resolved to, a signed-out tab included, or when the header is unreadable, and
 * writes one warn line (route, method, reason) so a client and server that
 * disagree on the key show up in the logs. Returns null when the route may go
 * on. A request with neither a header nor a signed-in cookie goes on under
 * either policy: there is no account to protect, and the route answers it as
 * signed out.
 */
export function requireExpectedViewer(
  request: Request,
  session: ExpectedViewerSession,
  policy: ExpectedViewerPolicy,
): NextResponse<ViewerChangedBody> | null {
  const reason = refusalOf(request.headers.get(EXPECTED_VIEWER_HEADER), admittedViewerKey(session), policy.missing);
  if (reason === null) return null;
  createRequestLogger(request, { route: policy.route }).warn('expected viewer refused', { status: 409, reason });
  return NextResponse.json(
    { code: VIEWER_CHANGED_CODE, error: VIEWER_CHANGED_ERROR },
    { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
