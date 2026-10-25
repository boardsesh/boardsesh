// Pure byte-level helpers shared by every image upload handler (avatars, gym
// logos and photos, feedback screenshots, spray-wall photos). No DB or handler
// imports, so any handler can use them without pulling in the gym resolvers.

/**
 * Stored extension per allowed mime type. Shared because every image upload
 * handler needs the same mapping, and a divergent copy would store the same
 * bytes under two different keys.
 */
export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Sniff the real image type from the file's magic bytes.
 *
 * The multipart `Content-Type` is whatever the CLIENT declared, and until this
 * check existed nothing ever read the bytes — so any payload labelled
 * `image/jpeg` was stored under our key and re-served from our origin with that
 * Content-Type. `nosniff` plus the raster-only allowlist keeps that from being
 * XSS, but it still let any authenticated uploader host arbitrary bytes on
 * boardsesh.com. Returns null when the bytes match no supported format.
 */
export function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }
  // RIFF....WEBP — the four-byte file size sits between the two tags.
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
