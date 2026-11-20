/**
 * The expected-viewer contract between the www session guard and the
 * cookie-authenticated `/api/internal/*` routes (#7596, owner decision 4).
 *
 * www and app.boardsesh.com share one session cookie. A tab that has not yet
 * noticed a switch made on the other origin still sends requests, and the
 * cookie answers them as the new account. The guard names the account the tab
 * shows in this header; a route whose cookie names another account answers 409
 * with `ViewerChangedBody` before it reads or writes anything. The value is
 * `sessionViewerKey` from `session-guard.ts`: `<userId>:<authSessionId>` when
 * signed in, `anonymous` when signed out. See docs/auth/better-auth-browser-session.md.
 */
export const EXPECTED_VIEWER_HEADER = 'X-Boardsesh-Expected-Viewer';
export const VIEWER_CHANGED_CODE = 'viewer_changed';

/**
 * Tabs loaded before the header existed show `error` as their failure toast,
 * so it is plain text a climber can act on. Current tabs never show it.
 */
export const VIEWER_CHANGED_ERROR = 'Reload this page.';

export type ViewerChangedBody = { readonly code: typeof VIEWER_CHANGED_CODE; readonly error: string };

// The 409 body is a few dozen bytes; anything longer is some other route's answer.
const MAX_VIEWER_CHANGED_BODY_BYTES = 256;

/** True for the body `requireExpectedViewer` answers, and for nothing else a route sends with 409. */
export function isViewerChangedBody(body: ArrayBuffer): boolean {
  if (body.byteLength === 0 || body.byteLength > MAX_VIEWER_CHANGED_BODY_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).code === VIEWER_CHANGED_CODE
    );
  } catch {
    return false;
  }
}
