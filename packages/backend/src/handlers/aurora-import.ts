import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { auroraExportSchema, importJsonExportData, type ImportProgressEvent } from '@boardsesh/aurora-sync/json-import';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { db } from '../db/client';
import { logger } from '../utils/logger';

const MAX_IMPORT_BODY_BYTES = 200 * 1024 * 1024;

const requestSchema = z.object({
  boardType: z.enum(AURORA_BOARDS),
  data: auroraExportSchema,
  skipFinalization: z.boolean().optional().default(false),
});

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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;

  for await (const chunk of req) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytesRead += chunkBuffer.byteLength;
    if (bytesRead > MAX_IMPORT_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunkBuffer);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body.trim()) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function writeImportEvent(res: ServerResponse, event: ImportProgressEvent): void {
  res.write(`${JSON.stringify(event)}\n`);
}

export async function handleAuroraImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 400, {
      error: error instanceof Error ? error.message : 'Invalid request body',
    });
    return;
  }

  const validationResult = requestSchema.safeParse(body);
  if (!validationResult.success) {
    sendJson(res, 400, { error: 'Invalid request body', details: validationResult.error.flatten() });
    return;
  }

  const { boardType, data, skipFinalization } = validationResult.data;

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    const results = await importJsonExportData(db, userId, boardType, data, (event) => writeImportEvent(res, event), {
      skipFinalization,
    });
    writeImportEvent(res, { type: 'complete', results });
  } catch (error) {
    logger.error('[AuroraImport] Import failed:', error);
    writeImportEvent(res, { type: 'error', error: error instanceof Error ? error.message : 'Import failed' });
  } finally {
    res.end();
  }
}
