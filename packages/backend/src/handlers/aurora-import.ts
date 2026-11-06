import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { auroraExportSchema, importJsonExportData, type ImportProgressEvent } from '@boardsesh/aurora-sync/json-import';
import { applyCorsHeaders } from './cors';
import { validateHttpAuthToken } from './auth-admission';
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

  const admission = await validateHttpAuthToken(token, res);
  if (!admission.available) return null;
  const authResult = admission.auth;
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

/** How many records to sample per array when reporting the export's shape. */
const SHAPE_SAMPLE_RECORDS = 50;
/** Upper bound on distinct key names reported, so a malformed file can't flood the log. */
const SHAPE_MAX_KEYS = 40;
/** Upper bound on a single reported key name's length. */
const SHAPE_MAX_KEY_LENGTH = 40;

/**
 * The FIELD NAMES an export's ascent/attempt records carry — never their values.
 *
 * Zod strips undeclared keys silently, which is how the mirror flag went
 * missing from every JSON-imported tick (#3521), and how `comment` /
 * `is_benchmark` are still being dropped today. A real Aurora account export is
 * requested by emailing Aurora support and contains personal data, so nobody on
 * the team has one to inspect and the file's shape stays guesswork until a real
 * import passes through here. Reporting the key names — sampled, capped,
 * truncated, values never read — turns the next real import into that answer
 * while retaining nothing about the climber or their logbook.
 */
function describeExportRecordShape(records: unknown[]): string {
  const keys = new Set<string>();
  for (const record of records.slice(0, SHAPE_SAMPLE_RECORDS)) {
    if (keys.size >= SHAPE_MAX_KEYS) break;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const key of Object.keys(record)) {
      if (keys.size >= SHAPE_MAX_KEYS) break;
      keys.add(key.slice(0, SHAPE_MAX_KEY_LENGTH));
    }
  }
  return [...keys].sort().join(',');
}

/** Log the sampled key names of one import chunk. Reads the RAW body, before zod strips it. */
function logExportShape(body: unknown, boardType: string): void {
  if (!body || typeof body !== 'object') return;
  const payload = (body as { data?: unknown }).data;
  if (!payload || typeof payload !== 'object') return;

  const { ascents, attempts } = payload as { ascents?: unknown; attempts?: unknown };
  const ascentKeys = Array.isArray(ascents) ? describeExportRecordShape(ascents) : '';
  const attemptKeys = Array.isArray(attempts) ? describeExportRecordShape(attempts) : '';
  if (!ascentKeys && !attemptKeys) return;

  logger.info(
    `[AuroraImport][3521] export record shape: boardType=${boardType} ascentKeys=${ascentKeys} attemptKeys=${attemptKeys}`,
  );
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

  // Before the parsed (stripped) payload is used anywhere, record what the raw
  // file actually carried. See describeExportRecordShape: names only. #3521
  logExportShape(body, boardType);

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
