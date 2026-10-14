import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BETA_THUMBNAIL_REQUEST_SIZE } from '../../packages/shared-schema/src/image-sizes';
import type { StaticManifestEntry } from './screenshot-fixtures';

const MAX_THUMBNAILS = 256;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MEDIA_ORIGIN = 'https://media.boardsesh.com';
const THUMBNAIL_PATH = /^\/static\/beta-link-thumbnails\/(?:instagram|tiktok)\/[A-Za-z0-9_-]{1,180}\.jpg$/;

/** Match the native cached-thumbnail request, without admitting arbitrary URLs. */
export function cppBetaThumbnailRequest(thumbnail: unknown): string | null {
  if (thumbnail === null || thumbnail === '') return null;
  if (typeof thumbnail !== 'string' || !THUMBNAIL_PATH.test(thumbnail))
    throw new Error('CPP beta thumbnail is not a supported cached native source');
  return `${thumbnail}?size=${BETA_THUMBNAIL_REQUEST_SIZE}`;
}

export function assertCppThumbnailRequestLimit(requests: ReadonlySet<string>): void {
  if (requests.size > MAX_THUMBNAILS) throw new Error('CPP beta thumbnail scope exceeds its request limit');
}

export async function inspectCppThumbnailImage(bytes: Buffer, contentType: string) {
  const formats: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !formats[contentType])
    throw new Error('CPP beta thumbnail has invalid recorded image bytes');
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if (metadata.format !== formats[contentType] || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1)
      throw new Error('Invalid thumbnail image');
    await decoder.raw().toBuffer();
    return { width: metadata.width, height: metadata.height };
  } catch {
    throw new Error('CPP beta thumbnail has invalid recorded image bytes');
  }
}

export type CppThumbnailProof = {
  request: string;
  sourceUrl: string;
  startedAt: string;
  completedAt: string;
  recordedAt?: string;
  status: 200;
  contentType: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
};

/** Genuine bounded downloads used only by the record-mode preparation proxy. */
export function createCppThumbnailRecording(upstream: string, allowedRequests: ReadonlySet<string>) {
  const proofs: CppThumbnailProof[] = [];
  let totalBytes = 0;
  const download = async (pathname: string, query: string): Promise<{ bytes: Buffer; contentType: string }> => {
    const request = `${pathname}?${query}`;
    assertCppThumbnailRequestLimit(allowedRequests);
    if (!allowedRequests.has(request) || cppBetaThumbnailRequest(pathname) !== request)
      throw new Error('CPP beta thumbnail request is outside its verified detail scope');
    if (proofs.some((proof) => proof.request === request))
      throw new Error('CPP beta thumbnail was requested more than once');
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // The backend owns the redirect. Its only accepted destination is the
      // public media object's exact native-size variant, without credentials.
      let sourceUrl = `${upstream}${request}`;
      let response = await fetch(sourceUrl, { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const destination = `${MEDIA_ORIGIN}${pathname.slice('/static'.length)}@${BETA_THUMBNAIL_REQUEST_SIZE}.jpg`;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location !== destination) throw new Error('Unexpected thumbnail redirect');
        sourceUrl = destination;
        response = await fetch(sourceUrl, { redirect: 'manual', signal: controller.signal });
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error('Invalid thumbnail response');
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const formats: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
      const declaredLength = response.headers.get('content-length');
      if (
        !contentType ||
        !formats[contentType] ||
        (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_IMAGE_BYTES))
      ) {
        await response.body.cancel();
        throw new Error('Invalid thumbnail content');
      }
      const chunks: Uint8Array[] = [];
      let imageBytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          imageBytes += chunk.value.byteLength;
          if (imageBytes > MAX_IMAGE_BYTES || totalBytes + imageBytes > MAX_TOTAL_BYTES)
            throw new Error('Thumbnail byte limit exceeded');
          chunks.push(chunk.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      if (!imageBytes || (declaredLength !== null && Number(declaredLength) !== imageBytes))
        throw new Error('Thumbnail body length differs');
      const bytes = Buffer.concat(chunks);
      // Decode all pixels to reject truncated bodies; the published file stays
      // the exact upstream bytes, never a re-encoded image.
      const metadata = await inspectCppThumbnailImage(bytes, contentType);
      totalBytes += imageBytes;
      proofs.push({
        request,
        sourceUrl,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 200,
        contentType,
        bytes: imageBytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: metadata.width,
        height: metadata.height,
      });
      return { bytes, contentType };
    } catch {
      // Network/decoder errors can contain URLs or response excerpts.
      throw new Error('CPP beta thumbnail genuine image download failed');
    } finally {
      clearTimeout(timer);
    }
  };
  const recorded = (entry: StaticManifestEntry, recordedAt: string): void => {
    const proof = proofs.find((candidate) => candidate.request === `${entry.path}?${entry.query}`);
    if (!proof || proof.recordedAt || proof.contentType !== entry.contentType || proof.bytes !== entry.bytes)
      throw new Error('CPP beta thumbnail recorder differs from the actual response');
    proof.recordedAt = recordedAt;
  };
  return { download, recorded, proofs };
}
