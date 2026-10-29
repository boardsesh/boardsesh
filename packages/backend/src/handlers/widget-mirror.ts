import type { IncomingMessage, ServerResponse } from 'http';
import { boardSupportsMirroring, parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { z } from 'zod';
import { applyCorsHeaders } from './cors';
import { authenticateWidget } from './widget-auth';
import { verifyWidgetSession } from './widget-session-guard';
import { checkWidgetRateLimit, ensureWidgetRateLimitPruner } from './widget-rate-limit';
import { mirrorSessionClimb, MirrorTargetChangedError } from '../services/queue-mirror';
import { eq } from 'drizzle-orm';
import { userBoards } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { resolveBoardBySlug } from '../graphql/resolvers/shared/board-lookup';
import { logger } from '../utils/logger';

const mirrorBody = z.object({
  sessionId: z.string().min(1),
  queueItemUuid: z.string().min(1),
  mirrored: z.boolean(),
});

/**
 * The board type and layout a session is on. A named path (`/b/<slug>`, a gym
 * wall or a home wall) carries neither. The session's own bound board
 * (`board_sessions.board_id`) is the exact answer; a slug can be reused once its
 * board is deleted, so the slug lookup (the watch's session-state endpoint's
 * way) is only the fallback for a session with no bound board. The caller has
 * already passed auth and the durable membership guard. Reading only the
 * positional tuple refused mirroring on every named wall (#7013).
 */
async function sessionBoardLayout(session: {
  boardPath: string;
  boardId: number | null;
}): Promise<{ boardName: string; layoutId: number } | null> {
  const named = parseNamedBoardPath(session.boardPath);
  if (!named) return parseBoardPath(session.boardPath);
  if (session.boardId != null) {
    const [bound] = await db
      .select({ boardType: userBoards.boardType, layoutId: userBoards.layoutId })
      .from(userBoards)
      .where(eq(userBoards.id, session.boardId))
      .limit(1);
    if (bound) return { boardName: bound.boardType, layoutId: Number(bound.layoutId) };
  }
  const board = await resolveBoardBySlug(named.slug);
  return board ? { boardName: board.boardType, layoutId: Number(board.layoutId) } : null;
}

/** Widget requests set an orientation on an exact queue slot, never on a moving index. */
export async function handleWidgetMirror(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
  let parsed: z.infer<typeof mirrorBody>;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > 4096) return reply(413, { error: 'Request too large' });
      chunks.push(bytes);
    }
    parsed = mirrorBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return reply(400, { error: 'Expected sessionId, queueItemUuid and mirrored' });
  }
  try {
    const auth = await authenticateWidget(req.headers.authorization, parsed.sessionId);
    if (auth.kind !== 'ok') return reply(auth.kind === 'wrong-session' ? 410 : 401, { error: 'Unauthorized' });
    if (!auth.userId) return reply(403, { error: 'An authenticated participant is required' });
    ensureWidgetRateLimitPruner();
    if (!checkWidgetRateLimit(parsed.sessionId)) return reply(429, { error: 'Too many requests' });
    const guard = await verifyWidgetSession(parsed.sessionId, auth.userId);
    if (!guard.ok) return reply(guard.status, { error: guard.error });
    const board = await sessionBoardLayout(guard.session);
    if (!board || !boardSupportsMirroring(board.boardName, board.layoutId)) {
      return reply(409, { error: 'This board does not support mirroring' });
    }
    const result = await mirrorSessionClimb(parsed.sessionId, parsed.mirrored, parsed.queueItemUuid);
    if (!result) return reply(409, { error: 'No current climb' });
    reply(200, { success: true, sessionId: parsed.sessionId, ...result.event, queueItemUuid: result.item.uuid });
  } catch (error) {
    if (error instanceof MirrorTargetChangedError) return reply(409, { error: error.message });
    logger.error('[WidgetMirror] Request failed:', error);
    reply(500, { error: 'Internal server error' });
  }
}
