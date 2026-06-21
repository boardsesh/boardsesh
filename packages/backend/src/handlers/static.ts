import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path, { extname } from 'path';
import { applyCorsHeaders } from './cors';
import { getAvatarsDir } from './avatars';
import { isS3Configured, getFromS3, uploadToS3 } from '../storage/s3';
import { type AllowedImageSize, resizeImageBuffer, resizedVariantKey, streamToBuffer } from '../lib/image-resize';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Serve a resized (size×size, JPEG) version of an S3 object. Returns false
 * when the base object doesn't exist (caller should 404); true once it has
 * written a response.
 *
 * `cacheVariant` controls whether the resized bytes are persisted back to
 * S3 under a `@<size>.jpg` key: immutable sources (beta thumbnails) cache;
 * mutable ones (avatars, overwritten on re-upload at the same key) resize
 * on the fly so a re-upload can't be shadowed by a stale variant. If the
 * resize itself fails (corrupt/unsupported source), the original bytes are
 * served unchanged.
 */
async function serveResizedImageFromS3(
  res: ServerResponse,
  baseKey: string,
  size: AllowedImageSize,
  options: { cacheVariant: boolean; cacheControl: string },
): Promise<boolean> {
  if (options.cacheVariant) {
    const cached = await getFromS3(resizedVariantKey(baseKey, size));
    if (cached) {
      res.writeHead(200, {
        'Content-Type': cached.contentType || 'image/jpeg',
        ...(cached.contentLength && { 'Content-Length': cached.contentLength }),
        'Cache-Control': options.cacheControl,
      });
      cached.stream.pipe(res);
      return true;
    }
  }

  const original = await getFromS3(baseKey);
  if (!original) return false;

  const originalBuffer = await streamToBuffer(original.stream);
  let body = originalBuffer;
  let contentType = original.contentType || 'application/octet-stream';
  try {
    body = await resizeImageBuffer(originalBuffer, size);
    contentType = 'image/jpeg';
    if (options.cacheVariant) {
      // Best-effort cache; serve the resized bytes regardless. ACL null —
      // we proxy these bytes ourselves, so no public-read is needed.
      try {
        await uploadToS3(body, resizedVariantKey(baseKey, size), 'image/jpeg', {
          cacheControl: options.cacheControl,
          acl: null,
        });
      } catch {
        // Ignore cache-write failures.
      }
    }
  } catch {
    // Resize failed — fall back to the original bytes (already assigned).
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': options.cacheControl,
  });
  res.end(body);
  return true;
}

/**
 * Static avatar file serving handler
 * GET /static/avatars/:filename
 *
 * When S3 is configured, proxies the image from S3 (avoids ACL/public access requirements).
 * Otherwise, serves avatar files from local storage with caching headers.
 */
export async function handleStaticAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  fileName: string,
  size: AllowedImageSize | null = null,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // Security: validate filename to prevent path traversal
  if (!fileName || fileName !== path.basename(fileName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  // If S3 is configured, proxy the image from S3
  // This avoids requiring S3 public access / ACLs which many S3-compatible services don't support
  if (isS3Configured()) {
    const s3Key = `avatars/${fileName}`;

    // Avatars are overwritten in place on re-upload (key = userId.ext), so
    // resize on the fly without persisting a variant — a cached variant
    // would shadow a new avatar. Matches the base avatar's 1-day cache.
    if (size !== null) {
      const served = await serveResizedImageFromS3(res, s3Key, size, {
        cacheVariant: false,
        cacheControl: 'public, max-age=86400',
      });
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    const s3Object = await getFromS3(s3Key);

    if (!s3Object) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const ext = extname(fileName).toLowerCase();
    const contentType = s3Object.contentType || MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      ...(s3Object.contentLength && { 'Content-Length': s3Object.contentLength }),
      'Cache-Control': 'public, max-age=86400', // 1 day
    });

    // Pipe the S3 stream to the response
    s3Object.stream.pipe(res);
    return;
  }

  // Serve from local storage. Note: the `?size=` resize path is S3-only — in
  // local-dev (no S3) we serve the full-size original, so avatar sizing is a
  // no-op there. That's intentional; production runs with S3 configured.
  const avatarsDir = getAvatarsDir();
  const filePath = path.join(avatarsDir, fileName);

  try {
    const fileStat = await stat(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Check If-None-Match for caching
    const etag = `"${fileStat.mtime.getTime()}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    // Check If-Modified-Since for caching
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const ifModifiedSinceDate = new Date(ifModifiedSince);
      if (fileStat.mtime <= ifModifiedSinceDate) {
        res.writeHead(304);
        res.end();
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStat.size,
      'Cache-Control': 'public, max-age=86400', // 1 day
      ETag: etag,
      'Last-Modified': fileStat.mtime.toUTCString(),
    });

    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

const BETA_THUMBNAIL_PLATFORMS = new Set(['instagram', 'tiktok']);
const BETA_THUMBNAIL_FILENAME = /^[A-Za-z0-9_-]+\.jpg$/;

/**
 * Static beta-link thumbnail serving handler
 * GET /static/beta-link-thumbnails/:platform/:filename
 *
 * Streams cached Instagram / TikTok beta-video thumbnails out of S3. Mirrors
 * the avatar pattern: clients receive a backend-relative URL and we proxy
 * the bytes from S3 ourselves, because Tigris on Railway doesn't honor the
 * `ACL: 'public-read'` we set on the upload.
 */
export async function handleStaticBetaThumbnail(
  req: IncomingMessage,
  res: ServerResponse,
  platform: string,
  fileName: string,
  size: AllowedImageSize | null = null,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (!BETA_THUMBNAIL_PLATFORMS.has(platform) || !BETA_THUMBNAIL_FILENAME.test(fileName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  if (!isS3Configured()) {
    // No S3 means no cached thumbnails to serve. Dev environments use the
    // /api/internal/beta-link-thumbnail proxy instead.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const s3Key = `beta-link-thumbnails/${platform}/${fileName}`;

  // Thumbnail keys are immutable per shortcode, so resized variants are
  // safe to cache in S3 and reuse.
  if (size !== null) {
    const served = await serveResizedImageFromS3(res, s3Key, size, {
      cacheVariant: true,
      cacheControl: 'public, max-age=31536000, immutable',
    });
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  const s3Object = await getFromS3(s3Key);

  if (!s3Object) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': s3Object.contentType || 'image/jpeg',
    ...(s3Object.contentLength && { 'Content-Length': s3Object.contentLength }),
    // Thumbnail keys are immutable per shortcode, so we can let the browser /
    // CDN cache aggressively.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  s3Object.stream.pipe(res);
}
