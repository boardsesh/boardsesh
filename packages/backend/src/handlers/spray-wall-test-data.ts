import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import { v4 as uuidv4 } from 'uuid';
import { applyCorsHeaders } from './cors';
import { guardUploadFileStream } from './http-utils';
import { detectImageMimeType, extractAuthTokenFromHeader, formatByteCapForMessage } from './gym-image-upload';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import { logger } from '../utils/logger';

// Spray-wall photo corpus configuration. Wall photos come straight off a phone
// camera rather than out of a screenshot pipeline, so the cap is twice the OCR
// one. HEIC is deliberately absent: nothing in this repo can decode it, so a
// HEIC in the corpus would be an object no training step could read.
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const STORAGE_PREFIX = 'spray-wall-test-data';

/**
 * Metadata a contributor sends alongside the photo.
 *
 * Everything except `wall` is optional — this is corpus collection from Discord
 * users, and a photo with a thin description is still worth more than a refused
 * upload. `consent.redistribute` is the one field with consequences: it records
 * whether the uploader allows the photo to be committed as a public test
 * fixture, so a missing/false value means "private corpus only".
 */
type SprayWallUploadMetadata = {
  wall: {
    angle?: number;
    description?: string;
  };
  capture?: {
    orientation?: 'portrait' | 'landscape';
    lighting?: string;
    hardCases?: string[];
  };
  consent?: {
    redistribute?: boolean;
  };
};

/**
 * Type guard for the contributor metadata. Shallow on purpose (same reasoning
 * as the OCR test-data handler): we require a `wall` object so every corpus
 * entry has somewhere for the wall facts to live, and let the rest through
 * unexamined rather than bouncing a real photo over a typo in an optional key.
 */
function isValidSprayWallMetadata(value: unknown): value is SprayWallUploadMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  return typeof metadata.wall === 'object' && metadata.wall !== null && !Array.isArray(metadata.wall);
}

/**
 * Generate a unique folder name for one corpus entry.
 * Format: {ISO-timestamp}-{uuid}
 */
function generateFolderName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uuid = uuidv4();
  return `${timestamp}-${uuid}`;
}

/**
 * Spray-wall hold-detection corpus upload handler
 * POST /api/spray-wall-test-data
 *
 * Expects multipart form data with:
 * - image: the wall photo
 * - metadata: JSON string describing the wall, the capture and the consent
 *
 * Requires authentication via Authorization header (Bearer token).
 * Any logged-in user can contribute a photo.
 *
 * Unlike the OCR test-data handler, the uploaded bytes are sniffed: the
 * multipart Content-Type is whatever the client declared, and these objects are
 * later pulled down and fed to a training pipeline, so bytes that contradict
 * the declared type are rejected rather than stored under a lying extension.
 */
export async function handleSprayWallTestDataUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // Check if S3 is configured - if not, skip silently
  if (!isS3Configured('private')) {
    logger.info('[Spray Wall Test Data] S3 not configured, skipping upload');
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
      // Before every early return: busboy destroys this stream with an error on
      // any truncated part, and an unlistened one exits the process (#5359).
      guardUploadFileStream(stream, { route: req.url ?? `/api/${STORAGE_PREFIX}`, field: name });

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
        res.end(JSON.stringify({ error: `File size must be less than ${formatByteCapForMessage(MAX_FILE_SIZE)}` }));
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

      // The declared type only says what the client claims; the magic bytes say
      // what it actually sent. Disagreement is rejected outright.
      if (detectImageMimeType(fileBuffer) !== mimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File contents do not match the declared image type' }));
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
      if (!isValidSprayWallMetadata(parsedMetadata)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid metadata structure: expected a wall object' }));
        resolve();
        return;
      }

      // Generate unique folder name
      const folderName = generateFolderName();
      const ext = MIME_TO_EXT[mimeType] || 'jpg';

      try {
        // Upload image to S3
        const imageKey = `${STORAGE_PREFIX}/${folderName}/image.${ext}`;
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
        const metadataKey = `${STORAGE_PREFIX}/${folderName}/metadata.json`;
        await uploadToS3('private', metadataBuffer, metadataKey, 'application/json');

        logger.info(`[Spray Wall Test Data] Uploaded corpus entry to ${folderName}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, folder: folderName }));
      } catch (uploadErr) {
        // Log error but return success to not affect main flow
        logger.error('[Spray Wall Test Data] Failed to upload:', uploadErr);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, skipped: true, reason: 'Upload failed' }));
      }
      resolve();
    });

    busboy.on('error', (err: Error) => {
      logger.error('[Spray Wall Test Data] Busboy error:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });

    req.pipe(busboy);
  });
}
