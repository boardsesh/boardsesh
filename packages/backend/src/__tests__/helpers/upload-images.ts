import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { UPLOAD_MAX_INPUT_PIXELS } from '../../lib/image-resize';

/**
 * Real images for the upload-handler tests. Every upload handler stores
 * sharp's re-encode, so a fixture has to be something sharp can decode.
 *
 * Each one is copied into a plain ArrayBuffer-backed Buffer, which is what
 * `new Blob([...])` accepts.
 */

/** A real 4 x 4 JPEG. */
export async function smallJpeg(): Promise<Buffer<ArrayBuffer>> {
  return Buffer.from(
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
}

/** A real 4 x 4 PNG. */
export async function smallPng(): Promise<Buffer<ArrayBuffer>> {
  return Buffer.from(
    await sharp({ create: { width: 4, height: 4, channels: 4, background: '#7c3aed80' } })
      .png()
      .toBuffer(),
  );
}

/** Marker appended after a real image's end; it must never reach storage. */
export const APPENDED_PAYLOAD_MARKER = '<script>upload-payload</script>';

/**
 * A real image followed by a payload. The magic bytes are right and sharp
 * decodes it fine, because libjpeg stops at the end-of-image marker.
 */
export function withAppendedPayload(image: Buffer): Buffer<ArrayBuffer> {
  return Buffer.from(Buffer.concat([image, Buffer.from(APPENDED_PAYLOAD_MARKER.repeat(2000), 'latin1')]));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/**
 * A valid, all-black 1-bit greyscale PNG one column wider than
 * UPLOAD_MAX_INPUT_PIXELS allows (8193 x 8192). It is about 8 KB, so it fits
 * under every byte cap, and it decodes cleanly under sharp's default limit:
 * only the explicit cap turns it away. Built by hand because asking sharp to
 * encode it would allocate the 67 MP it is meant to keep us from decoding.
 */
export function overPixelCapPng(): Buffer<ArrayBuffer> {
  const height = 8192;
  const width = Math.floor(UPLOAD_MAX_INPUT_PIXELS / height) + 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: greyscale
  // Each scanline is a filter byte (0, none) then ceil(width / 8) zero bytes.
  const scanlines = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return Buffer.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
