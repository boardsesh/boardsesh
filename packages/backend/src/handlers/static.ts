import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path, { extname } from 'path';
import { applyCorsHeaders } from './cors';
import { failUpstreamRead, pipeStreamToResponse } from './http-utils';
import { getAvatarsDir } from './avatars';
import { getGymLogosDir } from './gym-logos';
import { getGymPhotosDir } from './gym-photos';
import { isS3Configured, getFromS3, uploadToS3 } from '../storage/s3';
import { logger } from '../utils/logger';
import { type AllowedImageSize, resizeImageBuffer, resizedVariantKey, streamToBuffer } from '../lib/image-resize';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Avoid caching proxy misses; replacement objects can use the same storage key. */
function sendNotFound(res: ServerResponse, options: { noStore?: boolean } = {}): void {
  res.writeHead(404, {
    'Content-Type': 'application/json',
    ...(options.noStore && { 'Cache-Control': 'no-store' }),
  });
  res.end(JSON.stringify({ error: 'Not found' }));
}

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
  options: { cacheVariant: boolean; cacheControl: string; route: string },
): Promise<boolean> {
  if (options.cacheVariant) {
    const variantKey = resizedVariantKey(baseKey, size);
    const cached = await getFromS3('media', variantKey);
    if (cached && cached.contentLength === 0) {
      // A zero-byte cached variant would be served as an "OK" empty image.
      // Drop it and fall through to resizing the original. Logged because the
      // only outward sign is an elevated origin-hit rate on this key.
      logger.warn(`[Static] discarding zero-byte cached variant ${variantKey}; resizing original instead`);
      cached.stream.destroy();
    } else if (cached) {
      res.writeHead(200, {
        'Content-Type': cached.contentType || 'image/jpeg',
        ...(cached.contentLength && { 'Content-Length': cached.contentLength }),
        'Cache-Control': options.cacheControl,
      });
      await pipeStreamToResponse(cached.stream, res, { route: options.route, source: variantKey });
      return true;
    }
  }

  const original = await getFromS3('media', baseKey);
  if (!original) return false;

  // The one S3 body not routed through `pipeStreamToResponse`, and `for await`
  // rethrows. Unguarded, an R2 body that died here unwound past the router,
  // where `isClientAbortError` read `aborted` as a client walking away and
  // returned having written nothing — headers unsent, response unended, the
  // connection held open until the client timed out (#5359). Every sized avatar
  // / gym-logo / gym-photo request reaches this line (`cacheVariant: false`),
  // so answer it.
  let originalBuffer: Buffer;
  try {
    originalBuffer = await streamToBuffer(original.stream);
  } catch (error) {
    failUpstreamRead(res, { route: options.route, source: baseKey }, error);
    return true;
  }

  if (originalBuffer.length === 0) return false;
  let body = originalBuffer;
  let contentType = original.contentType || 'application/octet-stream';
  try {
    body = await resizeImageBuffer(originalBuffer, size);
    contentType = 'image/jpeg';
    if (options.cacheVariant) {
      // Best-effort cache; serve the resized bytes regardless. ACL null —
      // we proxy these bytes ourselves, so no public-read is needed.
      try {
        await uploadToS3('media', body, resizedVariantKey(baseKey, size), 'image/jpeg', {
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
  if (isS3Configured('media')) {
    const s3Key = `avatars/${fileName}`;

    // Avatars are overwritten in place on re-upload (key = userId.ext), so
    // resize on the fly without persisting a variant — a cached variant
    // would shadow a new avatar. Matches the base avatar's 1-day cache.
    if (size !== null) {
      const served = await serveResizedImageFromS3(res, s3Key, size, {
        cacheVariant: false,
        cacheControl: 'public, max-age=86400',
        route: req.url ?? '/static/avatars',
      });
      if (!served) {
        sendNotFound(res, { noStore: true });
      }
      return;
    }

    const s3Object = await getFromS3('media', s3Key);

    if (!s3Object) {
      sendNotFound(res, { noStore: true });
      return;
    }

    // A zero-byte object serves as `200 image/jpeg` with an empty body, which
    // <Image>/<img> report as a successful load — so the client paints an
    // empty circle and never runs its error fallback. 404 instead, strictly on
    // 0: an unknown (undefined) length must keep streaming as before.
    if (s3Object.contentLength === 0) {
      s3Object.stream.destroy();
      sendNotFound(res, { noStore: true });
      return;
    }

    const ext = extname(fileName).toLowerCase();
    const contentType = s3Object.contentType || MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      ...(s3Object.contentLength && { 'Content-Length': s3Object.contentLength }),
      'Cache-Control': 'public, max-age=86400', // 1 day
    });

    // Pipe the S3 stream to the response, guarding both ends.
    await pipeStreamToResponse(s3Object.stream, res, { route: req.url ?? '/static/avatars', source: s3Key });
    return;
  }

  // Serve from local storage. Note: the `?size=` resize path is S3-only — in
  // local-dev (no S3) we serve the full-size original, so avatar sizing is a
  // no-op there. That's intentional; production runs with S3 configured.
  const avatarsDir = getAvatarsDir();
  const filePath = path.join(avatarsDir, fileName);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.size === 0) {
      // Same reasoning as the S3 branch: an empty file is a broken avatar, and
      // serving it as 200 hides that from the client.
      sendNotFound(res, { noStore: true });
      return;
    }
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

    await pipeStreamToResponse(createReadStream(filePath), res, {
      route: req.url ?? filePath,
      source: filePath,
    });
  } catch {
    sendNotFound(res, { noStore: true });
  }
}

/**
 * Static gym-image file serving (logo and photo share every byte of this).
 *
 * Mirrors handleStaticAvatar: proxies the image from S3 when configured
 * (avoids ACL/public-access requirements), otherwise serves from local-dev
 * storage. Both kinds overwrite in place on re-upload (key = gymUuid.ext), so
 * the `?size=` resize path resizes on the fly without persisting a variant
 * that could shadow a newly uploaded image.
 */
async function serveStaticGymImage(
  req: IncomingMessage,
  res: ServerResponse,
  s3Prefix: string,
  localDir: string,
  fileName: string,
  size: AllowedImageSize | null,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  // These render on unauthenticated kiosk/embed/gym-page surfaces. The upload
  // allowlist already guarantees the stored Content-Type is a raster image type
  // (never image/svg+xml), so a spoofed SVG payload is served as e.g. image/png
  // — inert in an <img>. nosniff closes the residual risk of a client/proxy
  // content-sniffing its way to executing it anyway.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Security: validate filename to prevent path traversal
  if (!fileName || fileName !== path.basename(fileName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  if (isS3Configured('media')) {
    const s3Key = `${s3Prefix}/${fileName}`;

    if (size !== null) {
      const served = await serveResizedImageFromS3(res, s3Key, size, {
        cacheVariant: false,
        cacheControl: 'public, max-age=86400',
        route: req.url ?? `/static/${s3Prefix}`,
      });
      if (!served) {
        sendNotFound(res, { noStore: true });
      }
      return;
    }

    const s3Object = await getFromS3('media', s3Key);

    if (!s3Object) {
      sendNotFound(res, { noStore: true });
      return;
    }

    // Mirrors the avatar handler: a zero-byte object is a broken upload, and
    // serving it as a 200 makes the client believe the image loaded.
    if (s3Object.contentLength === 0) {
      s3Object.stream.destroy();
      sendNotFound(res, { noStore: true });
      return;
    }

    const ext = extname(fileName).toLowerCase();
    const contentType = s3Object.contentType || MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      ...(s3Object.contentLength && { 'Content-Length': s3Object.contentLength }),
      'Cache-Control': 'public, max-age=86400', // 1 day
    });

    await pipeStreamToResponse(s3Object.stream, res, { route: req.url ?? `/static/${s3Prefix}`, source: s3Key });
    return;
  }

  // Serve from local storage (the `?size=` resize path is S3-only; local-dev
  // serves the full-size original).
  const filePath = path.join(localDir, fileName);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.size === 0) {
      sendNotFound(res, { noStore: true });
      return;
    }
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const etag = `"${fileStat.mtime.getTime()}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

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

    await pipeStreamToResponse(createReadStream(filePath), res, {
      route: req.url ?? filePath,
      source: filePath,
    });
  } catch {
    sendNotFound(res, { noStore: true });
  }
}

/**
 * Static gym-logo file serving handler
 * GET /static/gym-logos/:filename
 */
export function handleStaticGymLogo(
  req: IncomingMessage,
  res: ServerResponse,
  fileName: string,
  size: AllowedImageSize | null = null,
): Promise<void> {
  return serveStaticGymImage(req, res, 'gym-logos', getGymLogosDir(), fileName, size);
}

/**
 * Static gym-photo file serving handler
 * GET /static/gym-photos/:filename
 */
export function handleStaticGymPhoto(
  req: IncomingMessage,
  res: ServerResponse,
  fileName: string,
  size: AllowedImageSize | null = null,
): Promise<void> {
  return serveStaticGymImage(req, res, 'gym-photos', getGymPhotosDir(), fileName, size);
}

const BETA_THUMBNAIL_PLATFORMS = new Set(['instagram', 'tiktok']);
const BETA_THUMBNAIL_FILENAME = /^[A-Za-z0-9_-]+\.jpg$/;

/**
 * Static beta-link thumbnail serving handler
 * GET /static/beta-link-thumbnails/:platform/:filename
 *
 * Proxies the media bucket when no public media base URL is configured.
 * The server routes configured public media URLs directly to the CDN before
 * reaching this handler; proxy guards do not repair existing CDN objects.
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

  if (!isS3Configured('media')) {
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
      route: req.url ?? '/static/beta-link-thumbnails',
    });
    if (!served) {
      // Empty and absent originals are both misses. Keep a separately repaired
      // object visible without waiting for a negatively cached proxy response.
      // Existing stored URLs do not automatically trigger a thumbnail re-fetch.
      sendNotFound(res, { noStore: true });
    }
    return;
  }

  const s3Object = await getFromS3('media', s3Key);

  if (!s3Object) {
    // A separately repaired object must not remain hidden by a cached miss.
    sendNotFound(res, { noStore: true });
    return;
  }

  // Same guard as the avatar / gym-logo handlers, and as the `?size=` branch
  // above: a zero-byte object is served as a "successful" empty image. Here it
  // matters more, not less — the 200 path is `immutable, max-age=1y`, so an
  // empty body would be pinned in browser and CDN caches. `no-store` on the
  // 404 keeps a re-cache at the same key able to repair it.
  if (s3Object.contentLength === 0) {
    s3Object.stream.destroy();
    sendNotFound(res, { noStore: true });
    return;
  }

  res.writeHead(200, {
    'Content-Type': s3Object.contentType || 'image/jpeg',
    ...(s3Object.contentLength && { 'Content-Length': s3Object.contentLength }),
    // Thumbnail keys are immutable per shortcode, so we can let the browser /
    // CDN cache aggressively.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  await pipeStreamToResponse(s3Object.stream, res, {
    route: req.url ?? '/static/beta-link-thumbnails',
    source: s3Key,
  });
}
