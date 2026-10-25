import sharp from 'sharp';
import type { Readable } from 'stream';
import { ALLOWED_IMAGE_SIZES, type AllowedImageSize } from '@boardsesh/shared-schema';

// Re-exported so handlers importing from this module get the allowlist from a
// single source (it lives in @boardsesh/shared-schema so the web + mobile
// clients that build `?size=` URLs share the same values).
export { ALLOWED_IMAGE_SIZES, type AllowedImageSize };

/**
 * Cache lifetime for a variant of a MUTABLE key (avatars, gym images).
 *
 * Matches what the proxying path served, so a client that drops the `?v=`
 * cache buster still self-heals within a day rather than pinning a replaced
 * image forever.
 */
export const MUTABLE_IMAGE_CACHE_CONTROL = 'public, max-age=86400';

/**
 * Parse a `?size=` query value against the allowlist. Returns null for
 * missing / non-numeric / out-of-allowlist values, in which case the
 * caller serves the original image (back-compat).
 */
export function parseSizeParam(raw: string | null | undefined): AllowedImageSize | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return (ALLOWED_IMAGE_SIZES as readonly number[]).includes(parsed) ? (parsed as AllowedImageSize) : null;
}

/**
 * S3 key for a resized variant of a base object, e.g.
 * `avatars/u1.jpg` → `avatars/u1.jpg@140.jpg`. Variants are always JPEG.
 */
export function resizedVariantKey(baseKey: string, size: AllowedImageSize): string {
  return `${baseKey}@${size}.jpg`;
}

/**
 * The most pixels sharp may decode from an uploaded avatar, gym logo, gym photo
 * or feedback screenshot: 8192 x 8192, about 67 MP.
 *
 * The largest real input is a web upload of a phone photo straight off the
 * camera. The biggest mainstream captures are the 48-50 MP high-resolution
 * modes (iPhone 48 MP is 8064 x 6048, Pixel and Galaxy 50 MP are 8160 x 6144),
 * so the cap clears those with a third to spare. A 200 MP capture is a 20 MB+
 * JPEG and never gets past the 2 MB / 5 MB byte caps anyway.
 *
 * sharp's own default (about 268 MP) is the problem this replaces: a flat PNG
 * that size compresses to a few hundred KB, fits under every byte cap, and
 * decodes to about 1 GB on a 4 GB box. At this cap the worst decode is about
 * 268 MB (4 bytes a pixel). sharp checks the cap against the header before it
 * decodes a pixel, and for an animated image it counts every frame, so a GIF
 * with more than 67 MP across its frames is refused too.
 */
export const UPLOAD_MAX_INPUT_PIXELS = 8192 * 8192;

/**
 * Resize an image buffer to fill a size×size square, re-encoding as JPEG.
 * Never upscales beyond the source (`withoutEnlargement`), so a small
 * source is returned at its own size rather than blown up. Refuses a source
 * over UPLOAD_MAX_INPUT_PIXELS; every caller already falls back on a failed
 * resize.
 */
export async function resizeImageBuffer(input: Buffer, size: AllowedImageSize): Promise<Buffer> {
  return sharp(input, { limitInputPixels: UPLOAD_MAX_INPUT_PIXELS })
    .resize(size, size, { fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Collect a readable stream into a single Buffer. No size cap — callers only
 * pass it size-bounded objects (avatars are limited by the upload handler;
 * beta thumbnails by the fetch/cache step). Add a cap before reusing this for
 * arbitrary/user-controlled object sizes.
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Thrown by writeImageVariants in `rejectUndecodable` mode when sharp cannot
 * decode the source. Nothing has been written when it is thrown: every resize
 * runs before the first write.
 */
export class UndecodableImageError extends Error {
  constructor(cause: unknown) {
    super('Image could not be decoded', { cause });
    this.name = 'UndecodableImageError';
  }
}

const STORED_FORMAT_BY_MIME_TYPE: Record<string, 'jpeg' | 'png' | 'webp' | 'gif'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Re-encode an uploaded image in its own format, so the stored object holds
 * only the pixels sharp decoded.
 *
 * Magic bytes and a successful decode are not enough on their own: libjpeg
 * stops at the end-of-image marker, so a real JPEG with any payload appended
 * after it passes both checks, and storing the raw upload would host that
 * payload on our origin. Re-encoding drops it, and drops EXIF (GPS included)
 * too, so the EXIF orientation is baked into still images first. sharp can
 * only turn a multi-page image by 180 degrees, so animated GIF/WebP frames
 * keep their stored orientation.
 *
 * Throws UndecodableImageError for a type it does not store, bytes sharp
 * cannot decode, or an image over UPLOAD_MAX_INPUT_PIXELS.
 */
export async function reencodeUploadedImage(input: Buffer, mimeType: string): Promise<Buffer> {
  const format = STORED_FORMAT_BY_MIME_TYPE[mimeType];
  if (!format) throw new UndecodableImageError(new Error(`Unsupported image type ${mimeType}`));
  try {
    // The metadata read applies the cap to the first frame's header; the
    // pipeline applies it again to every frame of an animated image.
    const { pages = 1 } = await sharp(input, { limitInputPixels: UPLOAD_MAX_INPUT_PIXELS }).metadata();
    const animated = pages > 1;
    let pipeline = sharp(input, { animated, limitInputPixels: UPLOAD_MAX_INPUT_PIXELS });
    if (!animated) pipeline = pipeline.autoOrient();
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 90 });
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 90 });
    else if (format === 'png') pipeline = pipeline.png();
    else pipeline = pipeline.gif();
    return await pipeline.toBuffer();
  } catch (decodeError) {
    throw new UndecodableImageError(decodeError);
  }
}

export interface WriteImageVariantsOptions {
  /**
   * Throw UndecodableImageError instead of storing the original bytes at every
   * variant key when sharp cannot decode the source. For user uploads, where a
   * file sharp cannot read is not an image we should be hosting at all.
   */
  rejectUndecodable?: boolean;
}

/**
 * Write every allowed resize variant of a freshly uploaded image.
 *
 * Called for the MUTABLE media keys (avatars, gym logos, gym photos), which the
 * proxying path deliberately never cached a variant for: the key is overwritten
 * in place on re-upload, so a cached variant could shadow a new image. Serving
 * the bucket directly removes the on-the-fly resizer, so every size a client can
 * request has to exist as an object — and the `?v=` cache buster already in the
 * stored URL is what keeps a replacement visible instead.
 *
 * Variants are written BEFORE their base object by the callers, so a reader who
 * can see a new base can always see its variants; a partial failure leaves the
 * previous image and its variants fully consistent and surfaces as a 500.
 */
export async function writeImageVariants(
  original: Buffer,
  baseKey: string,
  writeObject: (key: string, body: Buffer, contentType: string) => Promise<unknown>,
  sizes: readonly AllowedImageSize[] = ALLOWED_IMAGE_SIZES,
  originalContentType = 'image/jpeg',
  { rejectUndecodable = false }: WriteImageVariantsOptions = {},
): Promise<void> {
  const resized = await Promise.all(
    sizes.map(async (size) => {
      try {
        return {
          key: resizedVariantKey(baseKey, size),
          body: await resizeImageBuffer(original, size),
          contentType: 'image/jpeg',
        };
      } catch (decodeError) {
        if (rejectUndecodable) throw new UndecodableImageError(decodeError);
        // A source sharp cannot decode still has to produce an OBJECT at every
        // variant key, because direct-from-bucket serving has no fallback: a
        // missing key is a 404, not a slightly-too-large image. Storing the
        // original bytes mirrors what the proxying resize path did on a failed
        // resize — serve the original unchanged — and keeps the upload itself
        // succeeding, which matters more than the pixels being the right size.
        return { key: resizedVariantKey(baseKey, size), body: original, contentType: originalContentType };
      }
    }),
  );
  await Promise.all(resized.map(({ key, body, contentType }) => writeObject(key, body, contentType)));
}
