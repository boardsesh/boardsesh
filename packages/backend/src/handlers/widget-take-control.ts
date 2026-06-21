import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { authenticateWidget } from './widget-auth';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { setCurrentClimbAndPublish } from '../services/queue-navigation';
import { checkWidgetRateLimit, ensureWidgetRateLimitPruner } from './widget-rate-limit';
import { verifyWidgetSession } from './widget-session-guard';
import { logger } from '../utils/logger';

interface WidgetTakeControlBody {
  sessionId: string;
}

function isValidBody(body: unknown): body is WidgetTakeControlBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const MAX_BODY = 2048;

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

/**
 * Handle widget re-assert (legacy "take-control") requests.
 *
 * POST /api/widget/take-control
 * Headers:
 *   Authorization: Bearer <apnsToken>
 * Body: { sessionId: string }
 *
 * Sessions are always-live, so there is no driver to claim. The frozen native
 * iOS widget still POSTs this endpoint when the user taps its lightbulb — we
 * keep it returning 200 for wire-compat. Repurposed to RE-ASSERT the session's
 * current climb: re-publish it as the current climb so any BLE-capable phone in
 * the session re-sends it to the wall (`CurrentClimbChanged` fans out to all
 * members). With no current climb, it's a successful no-op.
 *
 * The bearer token must be registered to the requested session and must have a
 * bound `userId`. Legacy anonymous token rows are rejected because the backend
 * cannot map them to a stable participant id.
 */
export async function handleWidgetTakeControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    res.end(JSON.stringify({ success: false, error: 'Body must include sessionId (string)' }));
    return;
  }

  const { sessionId } = body;
  const authHeader = req.headers['authorization'];
  const authHeaderValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  const authResult = await authenticateWidget(authHeaderValue, sessionId).catch((error: unknown) => {
    logger.error('[WidgetTakeControl] Auth lookup failed:', error);
    return null;
  });

  if (authResult === null) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Auth error' }));
    return;
  }

  if (authResult.kind !== 'ok') {
    if (authResult.kind === 'wrong-session') {
      logger.info(
        `[WidgetTakeControl] Token bound to session ${authResult.boundSessionId}, request was for ${sessionId}; signaling re-register`,
      );
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Token bound to a different session; re-register' }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }

  if (!authResult.userId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Widget re-assert requires an authenticated participant' }));
    return;
  }

  // Per-session rate limit (shared with /api/widget/navigate, token bucket
  // capacity 2, refill 1 / 1.5s). The re-assert calls setCurrentClimbAndPublish,
  // whose optimistic-lock retry loop + BLE re-send make rapid lock-screen
  // lightbulb mashes a stampede risk. Applied after auth so an unauthenticated
  // caller can't poison a member's bucket.
  ensureWidgetRateLimitPruner();
  if (!checkWidgetRateLimit(sessionId)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Too many requests' }));
    return;
  }

  // Reject stale tokens whose session has ended or whose user isn't a
  // participant, before reading/re-publishing the queue (else a stale token
  // revives an ended session's persisted queue via setCurrentClimbAndPublish).
  const guard = await verifyWidgetSession(sessionId, authResult.userId);
  if (!guard.ok) {
    res.writeHead(guard.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: guard.error }));
    return;
  }

  try {
    // Re-assert the session's current climb so a BLE phone re-sends it. The
    // climb is already in the queue, so shouldAddToQueue=false — this just
    // re-publishes CurrentClimbChanged to every member. No current climb is a
    // successful no-op (nothing to re-send).
    const queueState = await roomManager.getQueueState(sessionId);
    const currentItem = queueState.currentClimbQueueItem;
    if (currentItem) {
      await setCurrentClimbAndPublish(
        sessionId,
        currentItem,
        false,
        roomManager,
        pubsub,
        undefined,
        'widget-take-control',
      );
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    logger.error('[WidgetTakeControl] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
}
