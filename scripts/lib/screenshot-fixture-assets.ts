import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Reserved, non-routable origin: replay binds these references to its own socket. */
export const SCREENSHOT_FIXTURE_ASSET_ORIGIN = 'https://screenshot-fixtures.boardsesh.invalid';
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const LOCAL_ASSET_EXPIRY = '9999-12-31T23:59:59.000Z';

export interface FixturePhoto {
  url: string;
  thumbUrl?: string | null;
  expiresAt: string;
  [key: string]: unknown;
}

export interface CapturedFixtureAsset {
  path: string;
  file: string;
  contentType: string;
  bytes: Buffer;
}

/** Only the authorized wall's private R2 photo is eligible; URLs never enter errors. */
export async function captureFixturePhoto(
  photo: FixturePhoto,
  wallUuid: string,
  download: typeof fetch = fetch,
): Promise<{ photo: FixturePhoto; assets: CapturedFixtureAsset[] }> {
  const assets: CapturedFixtureAsset[] = [];
  async function capture(source: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new Error('Invalid spray photo source URL');
    }
    if (
      parsed.protocol !== 'https:' ||
      !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(parsed.hostname) ||
      !parsed.pathname.startsWith(`/spray-walls/${wallUuid}/`) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('Spray photo source is not the authorized wall in private R2');
    }
    let response: Response;
    try {
      response = await download(source, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('Could not download the authorized spray photo');
    }
    if (!response.ok || !response.body) throw new Error('Spray photo download failed');
    if (Number(response.headers.get('content-length')) > MAX_PHOTO_BYTES) throw new Error('Spray photo exceeds 20 MiB');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error('Spray photo download body failed');
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_PHOTO_BYTES) {
        await reader.cancel();
        throw new Error('Spray photo exceeds 20 MiB');
      }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks);
    let format: string | undefined;
    try {
      format = (await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata()).format;
    } catch {
      throw new Error('Spray photo bytes are not a supported image');
    }
    if (!format || !['jpeg', 'png', 'webp'].includes(format))
      throw new Error('Spray photo bytes are not a supported image');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const extension = format === 'jpeg' ? 'jpg' : format;
    const path = `/static/campaign-spray/${hash}.${extension}`;
    assets.push({ path, file: `static/${hash}.${extension}`, contentType: `image/${format}`, bytes });
    return `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}${path}`;
  }
  const url = await capture(photo.url);
  const thumbUrl = photo.thumbUrl ? await capture(photo.thumbUrl) : photo.thumbUrl;
  return { photo: { ...photo, url, thumbUrl, expiresAt: LOCAL_ASSET_EXPIRY }, assets };
}

/** Does not alter ordinary production URLs. Reserved URLs must reference bundled static assets. */
export function bindFixtureAssetUrls(
  serializedResponse: string,
  origin: string,
  staticPaths: readonly string[],
): string {
  if (!serializedResponse.includes(SCREENSHOT_FIXTURE_ASSET_ORIGIN)) return serializedResponse;
  const root: unknown = JSON.parse(serializedResponse);
  function bind(node: unknown): unknown {
    if (typeof node === 'string' && node.startsWith(SCREENSHOT_FIXTURE_ASSET_ORIGIN)) {
      const parsed = new URL(node);
      if (
        parsed.origin !== SCREENSHOT_FIXTURE_ASSET_ORIGIN ||
        !/^\/static\/campaign-spray\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(parsed.pathname) ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error('Invalid reserved screenshot asset reference');
      }
      if (!staticPaths.includes(parsed.pathname))
        throw new Error('Reserved screenshot asset is missing from manifest.static');
      return `${origin}${parsed.pathname}`;
    }
    if (Array.isArray(node)) return node.map(bind);
    if (node && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, bind(child)]));
    return node;
  }
  return JSON.stringify(bind(root));
}
