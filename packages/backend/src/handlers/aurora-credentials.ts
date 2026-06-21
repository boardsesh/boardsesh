import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { isAuroraRequestError } from '@boardsesh/aurora-sync/api';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { KILTER_BOARD_TYPE } from '@boardsesh/kilter-sync/api';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import {
  deleteAuroraCredential,
  getAuroraCredentialStatuses,
  getAuroraUnsyncedCounts,
  isKilterSyncAllowed,
  saveAuroraCredential,
} from '../services/aurora-credentials';
import { logger } from '../utils/logger';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

const saveCredentialsSchema = z.object({
  boardType: z.enum(AURORA_BOARDS),
  username: z.string().min(1),
  password: z.string().min(1),
});

const deleteCredentialsSchema = z.object({
  boardType: z.enum(AURORA_BOARDS),
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
  let body = '';
  let bytesRead = 0;

  for await (const chunk of req) {
    const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytesRead += Buffer.byteLength(chunkText);
    if (bytesRead > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    body += chunkText;
  }

  if (!body.trim()) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function auroraErrorStatus(error: unknown): number {
  if (!isAuroraRequestError(error)) return 500;
  if (error.code === 'invalid_credentials') return 401;
  if (error.code === 'rate_limited') return 429;
  return 502;
}

function auroraErrorMessage(error: unknown): string {
  if (!isAuroraRequestError(error)) return 'Failed to save credentials';
  if (error.code === 'invalid_credentials') return 'Invalid Aurora credentials';
  if (error.code === 'rate_limited') return 'Too many login attempts. Please try again later.';
  return 'Aurora is unavailable. Please try again later.';
}

export async function handleAuroraCredentials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  if (req.method === 'GET') {
    const credentials = await getAuroraCredentialStatuses(userId);
    sendJson(res, 200, {
      credentials,
      kilterSyncAllowed: isKilterSyncAllowed(userId),
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 400, {
      error: error instanceof Error ? error.message : 'Invalid request body',
    });
    return;
  }

  if (req.method === 'POST') {
    const validationResult = saveCredentialsSchema.safeParse(body);
    if (!validationResult.success) {
      sendJson(res, 400, { error: 'Invalid request body', details: validationResult.error.flatten() });
      return;
    }

    const { boardType, username, password } = validationResult.data;
    if (boardType === KILTER_BOARD_TYPE) {
      sendJson(res, 400, { error: 'Kilter accounts use OAuth' });
      return;
    }

    try {
      const credential = await saveAuroraCredential({ userId, boardType, username, password });
      sendJson(res, 200, { success: true, credential });
    } catch (error) {
      logger.warn('[AuroraCredentials] Failed to save credentials:', error);
      sendJson(res, auroraErrorStatus(error), { error: auroraErrorMessage(error) });
    }
    return;
  }

  const validationResult = deleteCredentialsSchema.safeParse(body);
  if (!validationResult.success) {
    sendJson(res, 400, { error: 'Invalid request body', details: validationResult.error.flatten() });
    return;
  }

  try {
    const result = await deleteAuroraCredential(userId, validationResult.data.boardType);
    sendJson(res, result.success ? 200 : 207, result);
  } catch (error) {
    logger.warn('[AuroraCredentials] Failed to delete credentials:', error);
    sendJson(res, 500, { error: 'Failed to delete credentials' });
  }
}

export async function handleAuroraCredentialsUnsynced(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  const counts = await getAuroraUnsyncedCounts(userId);
  sendJson(res, 200, { counts });
}
