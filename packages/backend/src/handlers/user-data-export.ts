import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { pipeStreamToResponse } from './http-utils';
import { validateToken } from '../middleware/auth';
import { isAuroraBoardType } from '../services/user-data-export-format';
import {
  getDownloadableUserDataExport,
  getUserDataExportStatus,
  requestUserDataExport,
  type UserDataExportStatus,
} from '../services/user-data-export';

function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    sendJson(res, 401, { error: 'Authentication required' });
    return null;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    sendJson(res, 401, { error: 'Invalid or expired token' });
    return null;
  }

  return authResult.userId;
}

function parseBoardType(url: URL, res: ServerResponse) {
  const boardType = url.searchParams.get('boardType');
  if (!isAuroraBoardType(boardType)) {
    sendJson(res, 400, { error: 'Invalid or missing boardType' });
    return null;
  }

  return boardType;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function statusCodeForExportStatus(status: UserDataExportStatus['status']): number {
  if (status === 'generating') return 202;
  if (status === 'unavailable') return 501;
  return 200;
}

export async function handleUserDataExport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  const boardType = parseBoardType(url, res);
  if (!boardType) return;

  const status =
    req.method === 'POST'
      ? await requestUserDataExport(userId, boardType)
      : await getUserDataExportStatus(userId, boardType);

  sendJson(res, statusCodeForExportStatus(status.status), status);
}

export async function handleUserDataExportDownload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  const boardType = parseBoardType(url, res);
  if (!boardType) return;

  const file = await getDownloadableUserDataExport(userId, boardType);
  if (!file) {
    sendJson(res, 404, { error: 'Export is not ready' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': file.contentType ?? 'application/json',
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(file.contentLength != null ? { 'Content-Length': String(file.contentLength) } : {}),
  });

  await pipeStreamToResponse(file.stream, res, {
    route: '/api/user-data-export/download',
    source: file.key,
  });
}
