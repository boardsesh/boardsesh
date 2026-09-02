import { getPublicUrl, isS3Configured, uploadToS3 } from '../storage/s3';
import { assertAllowedImageHost, type ImageHostKind } from './safe-image-fetch';
import { logger } from '../utils/logger';

export { isS3Configured };

// Cap the cached thumbnail at 5 MB. IG/TikTok thumbnails are ~50–500 KB in
// practice; anything past 5 MB is either a hostile response or something
// other than the image we expect. AbortSignal.timeout only bounds wall-clock,
// not bytes, so this is the byte-level back-stop.
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

export const STATIC_THUMBNAIL_PREFIX = '/static/beta-link-thumbnails/';

/**
 * Direct-bucket URL prefixes that `board_beta_links.thumbnail` may still hold.
 *
 * Recognition used to be derived purely from `getPublicUrl`, which worked only
 * while the backend pointed at the bucket those URLs name. Moving storage to
 * Cloudflare R2 changes what `getPublicUrl` returns, so a surviving legacy row
 * would stop being recognised as ours and the resolver would re-fetch (and
 * re-cache) the image from Instagram/TikTok. Pinning the historical prefixes
 * keeps the short-circuit correct no matter where storage points today.
 *
 * Additive only: never remove an entry, even after a backfill. A row missed by
 * the backfill is the exact case this list exists for.
 */
export const LEGACY_THUMBNAIL_URL_PREFIXES: readonly string[] = [
  // The Railway object-storage bucket, retired in the R2 migration.
  'https://t3.storageapi.dev/structured-parcel-ei3jl8g/',
];

/**
 * URL we surface to clients for a cached thumbnail. Mirrors the avatar
 * pattern: backend-relative `/static/...` path that the backend proxies out
 * of S3 (Tigris on Railway doesn't honor `ACL: 'public-read'`, so direct
 * bucket URLs 403 in the browser).
 *
 * Strips a leading slash from the key so we never produce `/static//...`
 * if a future refactor changes how keys are constructed — that mismatched
 * URL would slip past `isOurS3Url` and silently break the resolver
 * short-circuit.
 */
function getStaticThumbnailUrl(key: string): string {
  const normalizedKey = key.replace(/^\/+/, '');
  return `/static/${normalizedKey}`;
}

/**
 * Dev-only thumbnail proxy. Used by both Instagram and TikTok branches when
 * S3 is not configured — lets the browser fetch CDN thumbnails through our
 * backend instead of cross-origin. The matching route is 410'd in production
 * whenever AWS_S3_BUCKET_NAME is set.
 */
export function getDevProxyThumbnailUrl(remoteUrl: string): string {
  return `/api/internal/beta-link-thumbnail?url=${encodeURIComponent(remoteUrl)}`;
}

const FETCH_TIMEOUT_MS = 4000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export function instagramThumbnailKey(mediaId: string): string {
  return `beta-link-thumbnails/instagram/${mediaId}.jpg`;
}

export function tiktokThumbnailKey(cacheId: string): string {
  return `beta-link-thumbnails/tiktok/${cacheId}.jpg`;
}

export function isOurS3Url(url: string | null): boolean {
  if (!url) return false;
  // New canonical form: backend-relative `/static/beta-link-thumbnails/...`
  // served via handleStaticBetaThumbnail.
  if (url.startsWith(STATIC_THUMBNAIL_PREFIX)) return true;
  // Legacy form (pre-#1734-fix): direct Tigris/S3 URL persisted from
  // getPublicUrl. These objects exist in our bucket but 403 in the browser
  // because Tigris ignores public-read ACLs. We still recognize them as
  // "ours" so the resolver short-circuit holds during/after the backfill;
  // the backfill rewrites these to the new prefix.
  if (LEGACY_THUMBNAIL_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  try {
    const ourPrefix = getPublicUrl('media', '');
    if (ourPrefix && url.startsWith(ourPrefix)) return true;
  } catch {
    // The bucket has no public URL base (or isn't configured) — the static
    // prefix and the hard-coded legacy list are all we can match on.
  }
  return false;
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer | null> {
  // Streaming path with hard byte cap. Wall-clock is bounded by the fetch
  // timeout but bytes aren't, so without this a hostile server over a fast
  // pipe could exhaust memory before AbortSignal.timeout fires.
  if (res.body) {
    const reader = res.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best-effort
        }
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  // Fallback for environments / mocks where `res.body` isn't a ReadableStream.
  // Fetch the whole buffer, then enforce the cap on the result. Less
  // protective than streaming (the byte cap doesn't help if Node already
  // buffered the whole response) but at least keeps the runtime check in
  // place for the upload step.
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) return null;
  return Buffer.from(arrayBuffer);
}

async function cacheRemoteThumbnail(key: string, sourceUrl: string, kind: ImageHostKind): Promise<string | null> {
  // SSRF defense: the source URL is derived from attacker-controlled HTML
  // (og:image / oembed.thumbnail_url), so refuse anything that isn't on the
  // platform's CDN allowlist or that resolves to a private IP.
  try {
    await assertAllowedImageHost(sourceUrl, kind);
  } catch (err) {
    logger.warn('[BetaLinks] rejected thumbnail source URL:', (err as Error).message);
    return null;
  }

  try {
    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      logger.warn(`[BetaLinks] rejected thumbnail with content-type ${contentType}`);
      return null;
    }
    const buffer = await readBodyWithCap(res, MAX_THUMBNAIL_BYTES);
    if (!buffer) {
      logger.warn(`[BetaLinks] thumbnail body exceeded ${MAX_THUMBNAIL_BYTES} bytes; aborted`);
      return null;
    }
    await uploadToS3('media', buffer, key, contentType);
    return getStaticThumbnailUrl(key);
  } catch (err) {
    logger.error('[BetaLinks] cacheRemoteThumbnail failed:', err);
    return null;
  }
}

export function cacheInstagramThumbnail(mediaId: string, fbcdnUrl: string): Promise<string | null> {
  return cacheRemoteThumbnail(instagramThumbnailKey(mediaId), fbcdnUrl, 'instagram');
}

export function cacheTikTokThumbnail(cacheId: string, tiktokCdnUrl: string): Promise<string | null> {
  return cacheRemoteThumbnail(tiktokThumbnailKey(cacheId), tiktokCdnUrl, 'tiktok');
}
