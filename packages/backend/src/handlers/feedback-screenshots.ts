import type { IncomingMessage, ServerResponse } from 'http';
import Busboy from 'busboy';
import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES, FEEDBACK_SCREENSHOT_PREFIX } from '@boardsesh/shared-schema';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { isS3Configured, uploadToS3 } from '../storage/s3';
import {
  detectImageMimeType,
  extractAuthTokenFromHeader,
  formatByteCapForMessage,
  GYM_IMAGE_ALLOWED_MIME_TYPES,
  MIME_TO_EXT,
} from './gym-image-upload';
import { logger } from '../utils/logger';

// Screenshot attached to a bug report or a QA verdict. One image per request;
// the client uploads each pick separately and sends the returned keys with the
// submission, which the backend renders as <img> tags in a GitHub comment or
// issue body.
//
// Unlike avatars and gym images this key is IMMUTABLE — every upload mints a
// fresh uuid — so there is no variant writing and no stale-extension cleanup to
// do, and the object can carry uploadToS3's default immutable Cache-Control.

const FEEDBACK_SCREENSHOTS_DIR = `./${FEEDBACK_SCREENSHOT_PREFIX}`;

// Per-user upload budget. An avatar is one key per user, overwritten in place,
// so a spammer there costs us nothing; here every upload writes a NEW object
// into the public media bucket, so an authenticated account could fill it
// without bound. A fixed window per process is deliberately coarse — it is a
// spam ceiling, not a fairness mechanism, and the real submission paths burn at
// most FEEDBACK_SCREENSHOT_MAX_COUNT per report. Being per-process, the true
// ceiling is 20 x the instance count and it resets on deploy; that is accepted
// here rather than reaching for Redis, because the budget only has to make
// scripted abuse tedious, not meter a paid resource. `applyRateLimit`, the
// two-tier limiter the resolvers use, is not reachable from a REST handler —
// it keys off the GraphQL connection context.
const RATE_LIMIT_MAX_UPLOADS = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** Prune only once the map is big enough to matter, so the common path is O(1). */
const RATE_LIMIT_PRUNE_AT_ENTRIES = 1000;

const uploadWindows = new Map<string, { count: number; windowStart: number }>();

/**
 * Clear the in-process upload counters. Test seam — the window is module state,
 * so a test that exhausts it needs this between cases.
 */
export function resetFeedbackScreenshotRateLimit(): void {
  uploadWindows.clear();
}

/**
 * Record one upload attempt for `userId`, returning false once the window's
 * budget is spent. Failed uploads count too: a rejected request still costs a
 * multipart parse, which is exactly what a spammer would loop on.
 */
function consumeUploadBudget(userId: string): boolean {
  const now = Date.now();

  if (uploadWindows.size >= RATE_LIMIT_PRUNE_AT_ENTRIES) {
    for (const [countedUserId, expiredCandidate] of uploadWindows) {
      if (now - expiredCandidate.windowStart >= RATE_LIMIT_WINDOW_MS) uploadWindows.delete(countedUserId);
    }
  }

  const userWindow = uploadWindows.get(userId);
  if (!userWindow || now - userWindow.windowStart >= RATE_LIMIT_WINDOW_MS) {
    uploadWindows.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (userWindow.count >= RATE_LIMIT_MAX_UPLOADS) return false;
  userWindow.count += 1;
  return true;
}

let localDirInitialized = false;

/**
 * Ensure the local-dev directory exists (first local-dev upload only).
 *
 * No EEXIST branch: `recursive: true` treats an existing directory as success,
 * so anything that does throw here is a real failure (a permission problem, a
 * file in the way) and belongs to the caller.
 */
async function ensureLocalDir(): Promise<void> {
  if (localDirInitialized) return;
  await mkdir(FEEDBACK_SCREENSHOTS_DIR, { recursive: true });
  localDirInitialized = true;
}

/**
 * Feedback screenshot upload handler
 * POST /api/feedback-screenshots
 *
 * Expects multipart form data with:
 * - screenshot: the image file (one per request)
 *
 * Requires authentication via Authorization header (Bearer token). Anonymous
 * uploads are deliberately unsupported — the object lands in a public bucket
 * and the rate limit is keyed on the user id, so there is no safe anonymous
 * form of this endpoint.
 *
 * Responds `{ success: true, key }` — the opaque object key the client hands
 * back on its submission. No URL: the only readers of these images are a GitHub
 * comment and the admin dashboard, and both get a `media.boardsesh.com` URL the
 * backend derives from the key at render time (`services/feedback-screenshot-urls.ts`).
 */
export async function handleFeedbackScreenshotUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

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

  if (!consumeUploadBudget(authResult.userId)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many screenshot uploads. Try again in a few minutes.' }));
    return;
  }

  const useS3 = isS3Configured('media');
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !useS3) {
    logger.error('Feedback screenshot upload attempted in production without S3 configured');
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Screenshot uploads are not configured. Please contact the administrator.' }));
    return;
  }

  if (!useS3) {
    try {
      await ensureLocalDir();
    } catch (error) {
      logger.error(`Failed to create ${FEEDBACK_SCREENSHOT_PREFIX} directory:`, error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server configuration error' }));
      return;
    }
  }

  return new Promise<void>((resolve) => {
    let busboy: ReturnType<typeof Busboy>;

    try {
      busboy = Busboy({
        headers: req.headers as { 'content-type': string },
        limits: { fileSize: FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES, files: 1 },
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request format' }));
      resolve();
      return;
    }

    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;
    let fileTruncated = false;
    let invalidMimeType = false;

    busboy.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
      if (name !== 'screenshot') {
        stream.resume();
        return;
      }

      mimeType = info.mimeType;
      if (!GYM_IMAGE_ALLOWED_MIME_TYPES.includes(mimeType)) {
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
      if (fileTruncated) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `File size must be less than ${formatByteCapForMessage(FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES)}`,
          }),
        );
        resolve();
        return;
      }

      if (invalidMimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only JPG, PNG, GIF, and WebP images are allowed' }));
        resolve();
        return;
      }

      // An empty multipart part would otherwise store a zero-byte object and
      // return a key the report then renders as a broken image.
      if (!fileBuffer || !mimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        resolve();
        return;
      }

      if (fileBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Uploaded file is empty' }));
        resolve();
        return;
      }

      // The declared Content-Type only got us past the allowlist; the BYTES
      // decide what we store. This is the security boundary of the endpoint:
      // without it any authenticated user can push arbitrary payloads labelled
      // image/jpeg into the public media bucket and have them served from
      // media.boardsesh.com under our key — file hosting on our domain, paid
      // for by us, for the price of one login.
      if (detectImageMimeType(fileBuffer) !== mimeType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File contents do not match the declared image type' }));
        resolve();
        return;
      }

      const ext = MIME_TO_EXT[mimeType] || 'jpg';
      const fileName = `${randomUUID()}.${ext}`;
      const key = `${FEEDBACK_SCREENSHOT_PREFIX}/${fileName}`;

      try {
        if (useS3) {
          // Immutable key, so uploadToS3's default immutable Cache-Control is
          // the right one and no resize variants are pre-written.
          await uploadToS3('media', fileBuffer, key, mimeType);
        } else {
          await writeFile(path.join(FEEDBACK_SCREENSHOTS_DIR, fileName), fileBuffer);
        }
      } catch (saveErr) {
        logger.error('Failed to save feedback screenshot:', saveErr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save screenshot' }));
        resolve();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, key }));
      resolve();
    });

    busboy.on('error', (err: Error) => {
      // The parser's own message describes our internals, so it goes to the log
      // and the caller gets the generic shape every other 400 here returns.
      logger.error('Feedback screenshot busboy error:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request format' }));
      resolve();
    });

    req.pipe(busboy);
  });
}
