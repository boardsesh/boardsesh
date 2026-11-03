import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { roomManager } from '../services/room-manager';
import { projectSessionBoardPath } from '../services/board-session-privacy';

/**
 * Determine WebSocket protocol based on request headers and environment
 */
function getWebSocketProtocol(req: IncomingMessage): 'wss' | 'ws' {
  // Check X-Forwarded-Proto header (set by reverse proxies like Railway, Vercel, etc.)
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto === 'https') {
    return 'wss';
  }

  // Check if running in production environment
  if (process.env.NODE_ENV === 'production') {
    return 'wss';
  }

  // Default to ws for development
  return 'ws';
}

/**
 * Session join redirect handler
 * GET /join/:sessionId
 *
 * Redirects to the board page with the session ID and backend URL
 */
export async function handleSessionJoin(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  port: number,
  boardseshUrl: string,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session ID is required' }));
    return;
  }

  const sessionInfo = await roomManager.getSessionById(sessionId);
  if (!sessionInfo) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  // Construct the backend WebSocket URL from the request host
  const host = req.headers.host || `localhost:${port}`;
  const wsProtocol = getWebSocketProtocol(req);
  const backendUrl = `${wsProtocol}://${host}/graphql`;
  // Signed out, so the path a stranger may see: a home wall's `/b/<slug>` (an
  // Unlisted wall's link) is named only to people who may read it (#7220).
  const visibleBoardPath = await projectSessionBoardPath(sessionInfo.boardPath ?? '', null);
  const redirectUrl = `${boardseshUrl}${visibleBoardPath}?backendUrl=${encodeURIComponent(backendUrl)}&sessionId=${encodeURIComponent(sessionId)}`;

  res.writeHead(302, { Location: redirectUrl });
  res.end();
}
