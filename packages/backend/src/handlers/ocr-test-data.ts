import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import { v4 as uuidv4 } from 'uuid';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { logger } from '../utils/logger';

// OCR test data upload configuration
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Expected metadata structure from OCR upload
// This matches the metadata object created in moonboard-ocr-upload.ts
type OcrUploadMetadata = {
  layoutId: number;
  angle: number;
  climb: {
    name?: string;
    grade?: string;
    holds?: unknown;
    sourceFile?: string;
  };
};

/**
 * Type guard to check if the parsed metadata has the expected structure.
 * We only validate the presence of required fields, not deep structure,
 * since this is for test data collection and flexibility is preferred.
 */
function isValidOcrMetadata(value: unknown): value is OcrUploadMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.layoutId === 'number' &&
    typeof obj.angle === 'number' &&
    typeof obj.climb === 'object' &&
    obj.climb !== null
  );
}

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
 * Generate a unique folder name for OCR test data
 * Format: {ISO-timestamp}-{uuid}
 */
function generateFolderName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uuid = uuidv4();
  return `${timestamp}-${uuid}`;
}

/**
 * OCR test data upload handler
 * POST /api/ocr-test-data
 *
 * Expects multipart form data with:
 * - image: the screenshot file
 * - metadata: JSON string with OCR results and metadata
 *
 * Requires authentication via Authorization header (Bearer token).
 * Any logged-in user can contribute test data.
 *
 * This is a fire-and-forget upload - errors are logged but don't fail the request.
 */
export async function handleOcrTestDataUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // Check if S3 is configured - if not, skip silently
  if (!isS3Configured('private')) {
    logger.info('[OCR Test Data] S3 not configured, skipping upload');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, skipped: true, reason: 'S3 not configured' }));
    return;
  }

  // Validate authentication
  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

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

    let metadataJson: string | undefined;
    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;
    let originalFilename: string | undefined;
    let fileTruncated = false;
    let invalidMimeType = false;

    busboy.on('field', (name: string, value: string) => {
      if (name === 'metadata') metadataJson = value;
    });

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      if (name !== 'image') {
        stream.resume();
        return;
      }

      mimeType = info.mimeType;
      originalFilename = info.filename;

      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        invalidMimeType = true;
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
      // Validate file size
      if (fileTruncated) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File size must be less than 10MB' }));
        resolve();
        return;
      }

      // Validate MIME type
      if (invalidMimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only JPG, PNG, and WebP images are allowed' }));
        resolve();
        return;
      }

      // Validate file was uploaded
      if (!fileBuffer || !mimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No image file uploaded' }));
        resolve();
        return;
      }

      // Validate metadata was provided
      if (!metadataJson) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Metadata is required' }));
        resolve();
        return;
      }

      // Parse metadata
      let parsedMetadata: unknown;
      try {
        parsedMetadata = JSON.parse(metadataJson);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid metadata JSON' }));
        resolve();
        return;
      }

      // Validate metadata structure
      if (!isValidOcrMetadata(parsedMetadata)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Invalid metadata structure: expected layoutId, angle, and climb fields',
          }),
        );
        resolve();
        return;
      }

      // Generate unique folder name
      const folderName = generateFolderName();
      const ext = MIME_TO_EXT[mimeType] || 'png';

      try {
        // Upload image to S3
        const imageKey = `moonboard-ocr-test-data/${folderName}/image.${ext}`;
        await uploadToS3('private', fileBuffer, imageKey, mimeType);

        // Prepare and upload metadata JSON
        const fullMetadata = {
          version: 1,
          uploadedAt: new Date().toISOString(),
          ...parsedMetadata,
          imageMetadata: {
            originalFilename: originalFilename || 'unknown',
            mimeType,
            fileSize: fileBuffer.length,
          },
        };

        const metadataBuffer = Buffer.from(JSON.stringify(fullMetadata, null, 2), 'utf-8');
        const metadataKey = `moonboard-ocr-test-data/${folderName}/parsed-result.json`;
        await uploadToS3('private', metadataBuffer, metadataKey, 'application/json');

        logger.info(`[OCR Test Data] Uploaded test data to ${folderName}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, folder: folderName }));
      } catch (uploadErr) {
        // Log error but return success to not affect main flow
        logger.error('[OCR Test Data] Failed to upload:', uploadErr);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, skipped: true, reason: 'Upload failed' }));
      }
      resolve();
    });

    busboy.on('error', (err: Error) => {
      logger.error('[OCR Test Data] Busboy error:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });

    req.pipe(busboy);
  });
}
