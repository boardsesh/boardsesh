import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { authenticateSessionRequest } from './session-auth';
import { verifyWidgetSession } from './widget-session-guard';
import { checkWidgetRateLimit, ensureWidgetRateLimitPruner } from './widget-rate-limit';
import { checkSessionUserRateLimit, ensureSessionUserRateLimitPruner } from './session-user-rate-limit';
import { navigateSessionQueue, reassertSessionCurrentClimb, type NavigateAction } from './session-queue-actions';
import { readJsonBody, sendJson } from './http-utils';
import { logger } from '../utils/logger';

/** Max session-control request body — these payloads are a sessionId + action. */
const MAX_BODY_BYTES = 2048;

/**
 * JWT-authenticated session control for non-WebSocket clients (the Garmin
 * watch). These are the mobile-JWT counterparts of the iOS lock-screen widget's
 * `/api/widget/navigate` + `/api/widget/take-control`: same server-authoritative
 * queue navigation, the same durable-participant + not-ended guard
 * (`verifyWidgetSession`), and the same per-session rate-limit bucket
 * (`checkWidgetRateLimit`) — the only difference is auth (a mobile JWT instead
 * of a registered APNs push token). A successful navigate publishes
 * `CurrentClimbChanged` so a session member's phone repaints the board.
 */

interface SessionNavigateBody {
  sessionId: string;
  action: NavigateAction;
}

function isValidNavigateBody(body: unknown): body is SessionNavigateBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  return candidate.action === 'next' || candidate.action === 'previous';
}

interface SessionTakeControlBody {
  sessionId: string;
}

function isValidTakeControlBody(body: unknown): body is SessionTakeControlBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0;
}

/**
 * POST /api/session/navigate
 * Headers: Authorization: Bearer <mobile JWT>
 * Body: { sessionId: string, action: "next" | "previous" }
 *
 * Advances/rewinds the session's current climb by one queue position (wrapping
 * at the ends) and returns `{ success, currentIndex }`. 401 (auth) / 403 (not a
 * participant) / 409 (empty queue or out of bounds) / 410 (session ended) / 429
 * (rate limited).
 */
export async function handleSessionNavigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureWidgetRateLimitPruner();
  ensureSessionUserRateLimitPruner();

  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  // Authenticate before reading the body. The mobile JWT is body-independent
  // (unlike the widget's session-bound auth, which must parse sessionId first),
  // so an unauthenticated caller is rejected before we spend the body read +
  // JSON parse.
  const auth = await authenticateSessionRequest(req);
  if (!auth.ok) {
    sendJson(res, auth.status, { success: false, error: auth.error });
    return;
  }

  // Per-user throttle BEFORE the body read + the guard's DB queries: a mobile JWT
  // authenticates any user for any sessionId, so a non-participant would
  // otherwise 403 at the guard on every request (never reaching the per-session
  // write bucket) and could spin the guard's queries unbounded.
  if (!checkSessionUserRateLimit(auth.userId)) {
    sendJson(res, 429, { success: false, error: 'Too many requests' });
    return;
  }

  let body: unknown;
  try {
    const raw = await readJsonBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
    return;
  }

  if (!isValidNavigateBody(body)) {
    sendJson(res, 400, {
      success: false,
      error: 'Body must include sessionId (string) and action ("next" | "previous")',
    });
    return;
  }

  const { sessionId, action } = body;

  // Membership guard BEFORE the rate limiter. Unlike the iOS widget — whose
  // APNs token is bound to one session, so only a participant ever reaches the
  // shared bucket — a mobile JWT authenticates ANY user for ANY sessionId. If
  // we rate-limited first, an authenticated non-participant who learns a session
  // id could drain that session's bucket (shared with the widget) and 429 real
  // members. So reject non-participants / ended sessions before spending a token.
  const guard = await verifyWidgetSession(sessionId, auth.userId);
  if (!guard.ok) {
    sendJson(res, guard.status, { success: false, error: guard.error });
    return;
  }

  // Shared per-session bucket with the iOS widget (capacity 2, refill 1 / 1.5s).
  if (!checkWidgetRateLimit(sessionId)) {
    sendJson(res, 429, { success: false, error: 'Too many requests' });
    return;
  }

  try {
    const outcome = await navigateSessionQueue(sessionId, action, 'session-navigate', auth.userId);

    if (outcome.kind === 'queue_empty') {
      sendJson(res, 409, { success: false, error: 'Queue is empty' });
      return;
    }
    if (outcome.kind === 'out_of_bounds') {
      sendJson(res, 409, { success: false, error: 'Target index out of bounds' });
      return;
    }

    sendJson(res, 200, { success: true, currentIndex: outcome.currentIndex });
  } catch (error) {
    // Detail stays in server logs; the remote client receives a generic message.
    logger.error('[SessionNavigate] Error:', error);
    sendJson(res, 500, { success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/session/take-control
 * Headers: Authorization: Bearer <mobile JWT>
 * Body: { sessionId: string }
 *
 * Re-asserts the session's current climb (re-publishes CurrentClimbChanged) so
 * a BLE-capable phone in the session re-sends it to the wall. No current climb
 * is a successful no-op.
 */
export async function handleSessionTakeControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureWidgetRateLimitPruner();
  ensureSessionUserRateLimitPruner();

  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  // Authenticate before reading the body (see handleSessionNavigate).
  const auth = await authenticateSessionRequest(req);
  if (!auth.ok) {
    sendJson(res, auth.status, { success: false, error: auth.error });
    return;
  }

  // Per-user throttle BEFORE the body read + the guard's DB queries: a mobile JWT
  // authenticates any user for any sessionId, so a non-participant would
  // otherwise 403 at the guard on every request (never reaching the per-session
  // write bucket) and could spin the guard's queries unbounded.
  if (!checkSessionUserRateLimit(auth.userId)) {
    sendJson(res, 429, { success: false, error: 'Too many requests' });
    return;
  }

  let body: unknown;
  try {
    const raw = await readJsonBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
    return;
  }

  if (!isValidTakeControlBody(body)) {
    sendJson(res, 400, { success: false, error: 'Body must include sessionId (string)' });
    return;
  }

  const { sessionId } = body;

  // Membership guard BEFORE the rate limiter — see handleSessionNavigate for
  // why (a mobile JWT isn't session-bound, so a non-participant must be 403'd
  // without draining the session's shared rate-limit bucket).
  const guard = await verifyWidgetSession(sessionId, auth.userId);
  if (!guard.ok) {
    sendJson(res, guard.status, { success: false, error: guard.error });
    return;
  }

  if (!checkWidgetRateLimit(sessionId)) {
    sendJson(res, 429, { success: false, error: 'Too many requests' });
    return;
  }

  try {
    await reassertSessionCurrentClimb(sessionId, 'session-take-control');
    sendJson(res, 200, { success: true });
  } catch (error) {
    logger.error('[SessionTakeControl] Error:', error);
    sendJson(res, 500, { success: false, error: 'Internal server error' });
  }
}
