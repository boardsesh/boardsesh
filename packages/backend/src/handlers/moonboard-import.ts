import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import type { MoonBoardImportProgressEvent } from '@boardsesh/shared-schema';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { db } from '../db/client';
import { importMoonBoardExportData } from '../services/moonboard-import';
import { logger } from '../utils/logger';

const MAX_IMPORT_BODY_BYTES = 25 * 1024 * 1024;

const moonBoardExportLogRowSchema = z
  .object({
    lineNumber: z.number().int().positive(),
    problemId: z.number().int().positive().optional(),
    name: z.string().min(1).max(200).optional(),
    setter: z.string().min(1).max(200).optional(),
    setup: z.string().min(1).max(100).optional(),
    angle: z.number().int().min(0).max(90).optional(),
    isBenchmark: z.boolean().optional(),
    comment: z.string().max(2000).optional(),
    grade: z.string().min(1),
    tries: z.string().min(1),
    attempts: z.number().int().min(0),
    rating: z.number().int().min(1).max(5).nullable(),
    date: z.string().min(1),
  })
  .refine((row) => row.problemId != null || row.name != null, { message: 'problemId or name is required' });

const requestSchema = z.object({
  data: z.object({
    user: z
      .object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        setterName: z.string().optional(),
        username: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
      })
      .default({}),
    logs: z.array(moonBoardExportLogRowSchema).default([]),
  }),
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

function writeImportEvent(res: ServerResponse, event: MoonBoardImportProgressEvent): void {
  res.write(`${JSON.stringify(event)}\n`);
}

export async function handleMoonBoardImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    const results = await importMoonBoardExportData(db, userId, validationResult.data.data, (event) =>
      writeImportEvent(res, event),
    );
    writeImportEvent(res, { type: 'complete', results });
  } catch (error) {
    logger.error('[MoonBoardImport] Import failed:', error);
    writeImportEvent(res, { type: 'error', error: error instanceof Error ? error.message : 'Import failed' });
  } finally {
    res.end();
  }
}
