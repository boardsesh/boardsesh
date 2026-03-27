import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import { eq } from 'drizzle-orm';
import { applyCorsHeaders } from './cors';
import { validateNextAuthToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { db } from '../db/client';
import { importJobs } from '@boardsesh/db/schema/app';
import { importDataSchema } from '../jobs/import-validation';
import { queueImportJob } from '../jobs/import-worker';
import { redisClientManager } from '../redis/client';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max for JSON import files
const VALID_BOARD_TYPES = ['kilter', 'tension'];

/**
 * Extract auth token from Authorization header
 */
function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Import data upload handler
 * POST /api/import
 *
 * Expects multipart form data with:
 * - file: the JSON file to import
 * - boardType: 'kilter' or 'tension'
 *
 * Requires authentication via Authorization header (Bearer token).
 */
export async function handleImportUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // Validate authentication
  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const authResult = await validateNextAuthToken(token);
  if (!authResult) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  // Check that S3 and Redis are available
  if (!isS3Configured()) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Import storage is not configured' }));
    return;
  }

  if (!redisClientManager.isRedisConnected()) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Import processing queue is not available' }));
    return;
  }

  const userId = authResult.userId;

  return new Promise<void>((resolve) => {
    let busboy: ReturnType<typeof Busboy>;

    try {
      busboy = Busboy({
        headers: req.headers as { 'content-type': string },
        limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request format' }));
      resolve();
      return;
    }

    let boardType: string | undefined;
    let fileBuffer: Buffer | undefined;
    let fileTruncated = false;

    busboy.on('field', (name: string, value: string) => {
      if (name === 'boardType') boardType = value;
    });

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
      stream.on('limit', () => {
        fileTruncated = true;
      });
    });

    busboy.on('finish', async () => {
      if (fileTruncated) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File size must be less than 50MB' }));
        resolve();
        return;
      }

      if (!boardType || !VALID_BOARD_TYPES.includes(boardType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boardType must be "kilter" or "tension"' }));
        resolve();
        return;
      }

      if (!fileBuffer) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        resolve();
        return;
      }

      // Parse and validate JSON structure
      let jsonData: unknown;
      try {
        jsonData = JSON.parse(fileBuffer.toString('utf-8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON file' }));
        resolve();
        return;
      }

      // Validate against schema (basic structural validation)
      const parseResult = importDataSchema.safeParse(jsonData);
      if (!parseResult.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Invalid import data format',
          details: parseResult.error.issues.slice(0, 5).map(i => i.message),
        }));
        resolve();
        return;
      }

      try {
        // Upload to S3
        const timestamp = Date.now();
        const s3Key = `imports/${userId}/${timestamp}.json`;
        await uploadToS3(fileBuffer, s3Key, 'application/json');

        // Create import job record
        const [job] = await db
          .insert(importJobs)
          .values({
            userId,
            boardType,
            s3Key,
            status: 'pending',
            totalItems:
              parseResult.data.follows.length +
              parseResult.data.circuits.length +
              parseResult.data.likes.length +
              parseResult.data.attempts.length +
              parseResult.data.ascents.length +
              parseResult.data.climbs.length,
          })
          .returning();

        // Queue the job in Redis
        await queueImportJob(job.id.toString());

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          jobId: job.id.toString(),
          message: 'Import job queued successfully',
          totalItems: parseResult.data.follows.length +
            parseResult.data.circuits.length +
            parseResult.data.likes.length +
            parseResult.data.attempts.length +
            parseResult.data.ascents.length +
            parseResult.data.climbs.length,
        }));
      } catch (err) {
        console.error('[Import] Failed to create import job:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create import job' }));
      }

      resolve();
    });

    busboy.on('error', (err: Error) => {
      console.error('[Import] Busboy error:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });

    req.pipe(busboy);
  });
}

/**
 * Import job status handler
 * GET /api/import/status?jobId=123
 *
 * Returns the current status of an import job.
 * Requires authentication - users can only check their own jobs.
 */
export async function handleImportStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const authResult = await validateNextAuthToken(token);
  if (!authResult) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('jobId');

  if (!jobId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'jobId query parameter is required' }));
    return;
  }

  try {
    const [job] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, BigInt(jobId)))
      .limit(1);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Import job not found' }));
      return;
    }

    // Authorization: users can only see their own jobs
    if (job.userId !== authResult.userId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: job.id.toString(),
      status: job.status,
      boardType: job.boardType,
      totalItems: job.totalItems,
      processedItems: job.processedItems,
      failedItems: job.failedItems,
      errors: job.errors,
      result: job.result,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    }));
  } catch (err) {
    console.error('[Import] Failed to fetch job status:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch job status' }));
  }
}
