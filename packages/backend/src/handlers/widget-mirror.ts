import type { IncomingMessage, ServerResponse } from 'http';
import { boardSupportsMirroring, parseBoardPath } from '@boardsesh/board-config';
import { z } from 'zod';
import { applyCorsHeaders } from './cors';
import { authenticateWidget } from './widget-auth';
import { verifyWidgetSession } from './widget-session-guard';
import { checkWidgetRateLimit, ensureWidgetRateLimitPruner } from './widget-rate-limit';
import { mirrorSessionClimb, MirrorTargetChangedError } from '../services/queue-mirror';
import { logger } from '../utils/logger';

const mirrorBody = z.object({
  sessionId: z.string().min(1),
  queueItemUuid: z.string().min(1),
  mirrored: z.boolean(),
});

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
    const board = parseBoardPath(guard.session.boardPath);
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
