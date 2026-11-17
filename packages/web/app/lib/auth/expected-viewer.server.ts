import 'server-only';
import { NextResponse } from 'next/server';
import { EXPECTED_VIEWER_HEADER, VIEWER_CHANGED_CODE, type ViewerChangedBody } from './expected-viewer';
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

const ANONYMOUS_VIEWER = sessionViewerKey(null);

function viewerChanged(): NextResponse<ViewerChangedBody> {
  return NextResponse.json(
    { code: VIEWER_CHANGED_CODE },
    { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** The cookie's account in the guard's key format, so both sides compare one string. */
export function admittedViewerKey(session: ExpectedViewerSession): string {
  const userId = session?.user?.id;
  return userId ? sessionViewerKey(signedInViewer(userId, session?.authSessionId)) : ANONYMOUS_VIEWER;
}

/**
 * Call right after the session read and before any other read or write. Answers
 * 409 `viewer_changed` when the request names another account than the cookie
 * resolved to, a signed-out tab included, or when the header is unreadable.
 * Returns null when the route may go on. A request with neither a header nor a
 * signed-in cookie goes on under either policy: there is no account to protect,
 * and the route answers it as signed out.
 */
export function requireExpectedViewer(
  request: Request,
  session: ExpectedViewerSession,
  missing: MissingExpectedViewer,
): NextResponse<ViewerChangedBody> | null {
  const expected = request.headers.get(EXPECTED_VIEWER_HEADER);
  const actual = admittedViewerKey(session);
  if (expected === null) return missing === 'allow' || actual === ANONYMOUS_VIEWER ? null : viewerChanged();
  // A malformed value never equals a key the session produces, so it is refused too.
  return expected === actual ? null : viewerChanged();
}
