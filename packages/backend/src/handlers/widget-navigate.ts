import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { navigateToQueueItem } from '../services/queue-navigation';

interface WidgetNavigateBody {
  sessionId: string;
  action: 'next' | 'previous';
  currentIndex: number;
}

function isValidBody(body: unknown): body is WidgetNavigateBody {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) return false;
  if (obj.action !== 'next' && obj.action !== 'previous') return false;
  if (typeof obj.currentIndex !== 'number' || !Number.isInteger(obj.currentIndex)) return false;
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

/**
 * Handle widget navigation requests.
 *
 * POST /api/widget/navigate
 * Body: { sessionId: string, action: "next" | "previous", currentIndex: number }
 *
 * This is a lightweight REST endpoint called by the iOS lock-screen widget
 * when the main app is suspended. No authentication is required because the
 * action is scoped to an already-existing session.
 */
export async function handleWidgetNavigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS headers (allow the widget's URLSession to call this)
  if (!applyCorsHeaders(req, res)) return;

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

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

  const { sessionId, action, currentIndex } = body;

  try {
    // Determine target index based on action and current queue state
    const queueState = await roomManager.getQueueState(sessionId);
    const queueLength = queueState.queue.length;

    if (queueLength === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Queue is empty' }));
      return;
    }

    let targetIndex: number;
    if (action === 'next') {
      targetIndex = currentIndex + 1;
      // Wrap around to the beginning
      if (targetIndex >= queueLength) {
        targetIndex = 0;
      }
    } else {
      targetIndex = currentIndex - 1;
      // Wrap around to the end
      if (targetIndex < 0) {
        targetIndex = queueLength - 1;
      }
    }

    const result = await navigateToQueueItem(
      sessionId,
      targetIndex,
      roomManager,
      pubsub,
      undefined, // no clientId for widget
      'widget-navigate',
    );

    if (result) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, currentIndex: targetIndex }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Target index out of bounds' }));
    }
  } catch (error) {
    console.error('[WidgetNavigate] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    );
  }
}
