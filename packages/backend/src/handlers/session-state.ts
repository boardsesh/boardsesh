import type { IncomingMessage, ServerResponse } from 'http';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { applyCorsHeaders } from './cors';
import { authenticateSessionRequest } from './session-auth';
import { verifyWidgetSession } from './widget-session-guard';
import { checkSessionUserRateLimit, ensureSessionUserRateLimitPruner } from './session-user-rate-limit';
import { sendJson } from './http-utils';
import { roomManager } from '../services/room-manager';
import { resolveBoardBySlug } from '../graphql/resolvers/shared/board-lookup';
import { logger } from '../utils/logger';

/**
 * GET /api/session/state?sessionId=<uuid>
 * Headers: Authorization: Bearer <mobile JWT>
 *
 * A slim, poll-friendly snapshot of a session's current climb for clients that
 * cannot hold a WebSocket subscription (the Garmin watch). Deliberately omits
 * the heavy `queue` array and every climb's `frames` string — the watch has
 * kilobytes of memory, so we return only what it needs to render the current
 * climb AND to build a `saveTick` (board resolution comes from the session's
 * `boardPath`, parsed server-side so the watch never has to).
 *
 * `sequence` / `stateHash` let the watch skip a re-render when nothing changed
 * between polls. 401 (auth) / 403 (not a participant) / 410 (session ended).
 */

export async function handleSessionState(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  ensureSessionUserRateLimitPruner();

  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const auth = await authenticateSessionRequest(req);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return;
  }

  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    sendJson(res, 400, { error: 'sessionId query parameter is required' });
    return;
  }

  // Per-user read limiter BEFORE the guard's DB reads, so a client hammering the
  // 3s poll can't drive unbounded getQueueState/verifyWidgetSession load.
  if (!checkSessionUserRateLimit(auth.userId)) {
    sendJson(res, 429, { error: 'Too many requests' });
    return;
  }

  const guard = await verifyWidgetSession(sessionId, auth.userId);
  if (!guard.ok) {
    sendJson(res, guard.status, { error: guard.error });
    return;
  }

  try {
    // Reuse the session row the guard already loaded — no second getSessionById
    // round-trip, since the watch polls this endpoint continuously.
    const queueState = await roomManager.getQueueState(sessionId);
    const namedBoardPath = parseNamedBoardPath(guard.session.boardPath);
    let parsedBoard = namedBoardPath ? null : parseBoardPath(guard.session.boardPath);
    if (namedBoardPath) {
      // Auth and durable session membership already passed. Use the same raw
      // lookup as boardBySlug, avoiding profile/count enrichment on every poll.
      const board = await resolveBoardBySlug(namedBoardPath.slug);
      if (board) {
        parsedBoard = {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: namedBoardPath.angle ?? board.angle,
        };
      }
    } else if (parsedBoard === null) {
      // Neither a positional board path nor a named-board (/b/{slug}) path — a
      // genuinely malformed value. The watch gets null board fields and can't
      // build a saveTick, so surface it. A valid named path with no surviving
      // board also returns null fields without warning on every ~3s poll.
      logger.warn(
        `[SessionState] Could not parse boardPath for session ${sessionId}: ${JSON.stringify(guard.session.boardPath)}`,
      );
    }

    const currentItem = queueState.currentClimbQueueItem;
    const currentIndex = currentItem ? queueState.queue.findIndex((q) => q.uuid === currentItem.uuid) : -1;

    const climb = currentItem
      ? {
          climbUuid: currentItem.climb.uuid,
          name: currentItem.climb.name,
          difficulty: currentItem.climb.difficulty,
          angle: currentItem.climb.angle,
          mirrored: currentItem.climb.mirrored === true,
          isBenchmark: currentItem.climb.benchmark_difficulty != null && currentItem.climb.benchmark_difficulty !== '',
        }
      : null;

    sendJson(res, 200, {
      sessionId,
      sequence: queueState.sequence,
      stateHash: queueState.stateHash,
      currentIndex,
      queueLength: queueState.queue.length,
      boardType: parsedBoard?.boardName ?? null,
      layoutId: parsedBoard?.layoutId ?? null,
      sizeId: parsedBoard?.sizeId ?? null,
      setIds: parsedBoard?.setIds ?? null,
      angle: parsedBoard?.angle ?? null,
      climb,
    });
  } catch (error) {
    logger.error('[SessionState] Error:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}
