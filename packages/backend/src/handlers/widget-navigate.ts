import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { navigateSessionQueue } from './session-queue-actions';
import { authenticateWidget, type WidgetAuthResult } from './widget-auth';
import {
  trackLiveActivityWidgetNavigation,
  trackLiveActivityWidgetNavigationAttributionGap,
} from '../services/analytics/live-activity';
import { checkWidgetRateLimit, ensureWidgetRateLimitPruner, __resetWidgetRateLimitForTests } from './widget-rate-limit';
import { verifyWidgetSession } from './widget-session-guard';
import { logger } from '../utils/logger';

// Re-exported so existing callers/tests that import the reset from this module
// keep working after the bucket moved to the shared widget-rate-limit module.
export { __resetWidgetRateLimitForTests };

interface WidgetNavigateBody {
  sessionId: string;
  action: 'next' | 'previous';
  currentIndex: number;
}

/**
 * Validate the widget request body.
 *
 * `currentIndex` is required and shape-checked but the handler does not use
 * its value — once the request passes auth + rate-limit, the server resolves
 * the authoritative index from `roomManager.getQueueState` (see the call site
 * around the `_ignoredClientIndex` destructuring below for the full rationale).
 * The field is still validated here so malformed payloads from a future widget
 * regression get rejected at the door rather than coercing into a no-op.
 * Dropping the field from the schema would break wire-compat with the already-
 * shipped iOS widget, which always sends it.
 */
function isValidBody(body: unknown): body is WidgetNavigateBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  if (candidate.action !== 'next' && candidate.action !== 'previous') return false;
  if (
    typeof candidate.currentIndex !== 'number' ||
    !Number.isInteger(candidate.currentIndex) ||
    candidate.currentIndex < 0
  ) {
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const MAX_BODY = 4096; // 4 KB is more than enough for this payload

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

type WidgetNavigationAnalyticsPayload = Parameters<typeof trackLiveActivityWidgetNavigation>[0];

/**
 * `userId` only picks which event fires: a token bound to a user is a normal
 * navigation, one without is an attribution gap. Neither event carries the id.
 */
function trackWidgetNavigation(userId: string | null, event: WidgetNavigationAnalyticsPayload): void {
  if (userId) {
    trackLiveActivityWidgetNavigation(event);
    return;
  }

  trackLiveActivityWidgetNavigationAttributionGap({
    ...event,
    reason: 'missing_user_id',
  });
}

/**
 * Handle widget navigation requests.
 *
 * POST /api/widget/navigate
 * Headers:
 *   Authorization: Bearer <apnsToken>  -- the registered APNs Live Activity
 *                                         push token for the session.
 * Body: { sessionId: string, action: "next" | "previous", currentIndex: number }
 *
 * This is a lightweight REST endpoint called by the iOS lock-screen widget
 * when the main app is suspended. Authentication is enforced via the
 * registered ActivityKit push token: a row must exist in
 * `activity_push_tokens` with `(token = bearer, sessionId = body.sessionId)`.
 * The token is itself only known to the device that registered it (via the
 * authenticated `registerActivityPushToken` GraphQL mutation), so possession
 * proves the device is a participant in the session.
 *
 * Per-session rate limit (token bucket, capacity 2, refill 1 / 1.5s) returns
 * 429 to absorb widget-button mashes.
 */
export async function handleWidgetNavigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureWidgetRateLimitPruner();

  // CORS headers (allow the widget's URLSession to call this).
  // applyCorsHeaders already replies 200 for OPTIONS preflight and returns
  // false, so we short-circuit on that path.
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    return;
  }

  if (!isValidBody(body)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: 'Body must include sessionId (string), action ("next" | "previous"), and currentIndex (integer)',
      }),
    );
    return;
  }

  // currentIndex is intentionally aliased to `_ignoredClientIndex` — see the
  // server-authoritative index lookup further down and the doc comment on
  // `isValidBody` above. The widget sends it, we validate it, but we never use
  // its value.
  const { sessionId, action, currentIndex: _ignoredClientIndex } = body;

  // Auth: bearer token must be registered to this sessionId
  const authHeader = req.headers['authorization'];
  const authHeaderValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  let authResult: WidgetAuthResult;
  try {
    authResult = await authenticateWidget(authHeaderValue, sessionId);
  } catch (error) {
    logger.error('[WidgetNavigate] Auth lookup failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Auth error' }));
    return;
  }

  if (authResult.kind !== 'ok') {
    if (authResult.kind === 'wrong-session') {
      // Token is known but bound to a different session. Returning 410 Gone
      // signals the widget to clear its cached push token and trigger a
      // re-registration via the main app.
      logger.info(
        `[WidgetNavigate] Token bound to session ${authResult.boundSessionId}, request was for ${sessionId}; signaling re-register`,
      );
      trackWidgetNavigation(authResult.userId, {
        sessionId,
        action,
        outcome: 'wrong_session',
        statusCode: 410,
        boundSessionId: authResult.boundSessionId,
      });
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Token bound to a different session; re-register' }));
      return;
    }
    // Missing or unknown bearer tokens are unauthenticated requests, not
    // successful Live Activity usage. Keep 401s out of analytics so arbitrary
    // callers cannot create PostHog events by guessing tokens or session IDs.
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }

  try {
    // Sessions are always-live: any current session member may navigate the
    // wall (no driver gate). The Live Activity token proves the user joined at
    // some point, but that row outlives session-end and leave — so re-check the
    // durable session/membership below before mutating.

    // Rate limit (per session) — apply *after* auth so an unauthenticated
    // caller can't poison a member's bucket.
    if (!checkWidgetRateLimit(sessionId)) {
      trackWidgetNavigation(authResult.userId, {
        sessionId,
        action,
        outcome: 'rate_limited',
        statusCode: 429,
      });
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Too many requests' }));
      return;
    }

    // Reject stale tokens whose session has ended or whose user isn't a
    // participant, before any queue read/mutation (else a stale token revives
    // an ended session's persisted queue).
    const guard = await verifyWidgetSession(sessionId, authResult.userId);
    if (!guard.ok) {
      trackWidgetNavigation(authResult.userId, {
        sessionId,
        action,
        outcome: guard.status === 410 ? 'session_ended' : 'not_participant',
        statusCode: guard.status,
      });
      res.writeHead(guard.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: guard.error }));
      return;
    }

    // Compute the target index from the authoritative queue and publish the
    // change. Shared with /api/session/navigate (the Garmin watch) via
    // navigateSessionQueue so the server-authoritative index math lives in one
    // place. `currentIndex` in the request body is validated but ignored.
    const outcome = await navigateSessionQueue(sessionId, action, 'widget-navigate');

    if (outcome.kind === 'queue_empty') {
      // Return 4xx so the widget's status-code check fires its Darwin-notification
      // fallback and the user sees a real error path rather than a silent no-op.
      trackWidgetNavigation(authResult.userId, {
        sessionId,
        action,
        outcome: 'queue_empty',
        statusCode: 409,
        queueLength: 0,
      });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Queue is empty' }));
      return;
    }

    if (outcome.kind === 'out_of_bounds') {
      // Same reasoning as the queue-empty branch: 4xx surfaces the failure
      // to the widget's HTTP fallback path.
      trackWidgetNavigation(authResult.userId, {
        sessionId,
        action,
        outcome: 'target_out_of_bounds',
        statusCode: 409,
        queueLength: outcome.queueLength,
        serverCurrentIndex: outcome.serverCurrentIndex,
        targetIndex: outcome.targetIndex,
      });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Target index out of bounds' }));
      return;
    }

    trackWidgetNavigation(authResult.userId, {
      sessionId,
      action,
      outcome: 'success',
      statusCode: 200,
      queueLength: outcome.queueLength,
      serverCurrentIndex: outcome.serverCurrentIndex,
      targetIndex: outcome.targetIndex,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, currentIndex: outcome.currentIndex }));
  } catch (error) {
    // Detail (DB connection strings, stack traces, schema hints) stays in
    // server logs; the iOS widget receives only a generic message so we don't
    // leak internals to a remote client.
    logger.error('[WidgetNavigate] Error:', error);
    trackWidgetNavigation(authResult.userId, {
      sessionId,
      action,
      outcome: 'error',
      statusCode: 500,
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
}
