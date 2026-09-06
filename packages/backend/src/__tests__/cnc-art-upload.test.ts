import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import sharp from 'sharp';

/**
 * The upload route end to end, over a real socket.
 *
 * A real HTTP server rather than a fake request object, because busboy is half
 * of what is under test: the size cap, the field name and the truncation flag
 * are all transport behaviour, and none of them is exercised by handing the
 * handler a buffer.
 *
 * Storage and the row are mocked. What matters about them here is the ORDER —
 * the object is written before the row — and that a rejection reaches neither.
 */

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn());
const uploadToS3Mock = vi.hoisted(() => vi.fn());
const createArtAssetMock = vi.hoisted(() => vi.fn());
const checkRateLimitRedisMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({ validateToken: validateTokenMock }));

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
}));

// The database is never reached: `createArtAsset` is the only thing this route
// writes, and mocking the client keeps the suite off Postgres entirely.
vi.mock('../db/client', () => ({ db: {} }));

vi.mock('../services/cnc/art-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cnc/art-assets')>()),
  createArtAsset: createArtAssetMock,
}));

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: checkRateLimitRedisMock }));

const { handleCncArtUpload } = await import('../handlers/cnc-art-upload');
const { RateLimitError } = await import('../utils/rate-limiter');

const USER_ID = '33333333-3333-4333-8333-333333333333';

const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 90 Z"/></svg>';
const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>fetch("/")</script></svg>';

async function startServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void handleCncArtUpload(req, res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unhandled' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postArt(
  baseUrl: string,
  file: { bytes: Buffer | string; type: string; name: string; field?: string },
  options: { authorization?: string | null } = {},
): Promise<Response> {
  const body = new FormData();
  const bytes = typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : file.bytes;
  body.set(file.field ?? 'art', new Blob([new Uint8Array(bytes)], { type: file.type }), file.name);

  const authorization = options.authorization === undefined ? 'Bearer art-token' : options.authorization;
  return fetch(`${baseUrl}/api/cnc/art`, {
    method: 'POST',
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
    body,
  });
}

/** A real PNG, so `sharp` reads real dimensions rather than a mocked answer. */
function makePng(size: number): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  validateTokenMock.mockResolvedValue({ userId: USER_ID });
  isS3ConfiguredMock.mockReturnValue(true);
  uploadToS3Mock.mockResolvedValue({ key: 'stored' });
  createArtAssetMock.mockResolvedValue({ id: 'asset' });
  checkRateLimitRedisMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/cnc/art', () => {
  it('stores a PNG with the dimensions it decoded, object before row', async () => {
    const png = await makePng(128);
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: png, type: 'image/png', name: 'logo.png' });
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        assetId: string;
        mime: string;
        widthPx: number;
        heightPx: number;
        sizeBytes: number;
      };
      expect(payload.mime).toBe('image/png');
      expect(payload.widthPx).toBe(128);
      expect(payload.heightPx).toBe(128);
      expect(payload.sizeBytes).toBe(png.length);

      const [bucket, buffer, key, contentType, options] = uploadToS3Mock.mock.calls[0] as [
        string,
        Buffer,
        string,
        string,
        { cacheControl?: string },
      ];
      expect(bucket).toBe('private');
      expect(buffer.equals(png)).toBe(true);
      expect(key).toBe(`cnc-art/${USER_ID}/${payload.assetId}.png`);
      expect(contentType).toBe('image/png');
      expect(options.cacheControl).toBe('private, no-store');

      // A row with no object behind it is artwork the generator cannot fetch.
      expect(uploadToS3Mock.mock.invocationCallOrder[0]).toBeLessThan(createArtAssetMock.mock.invocationCallOrder[0]);
      expect(createArtAssetMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, mime: 'image/png', widthPx: 128, heightPx: 128 }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it('stores an SVG re-serialised, with no pixel dimensions', async () => {
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: CLEAN_SVG, type: 'image/svg+xml', name: 'logo.svg' });
      expect(response.status).toBe(200);

      const payload = (await response.json()) as { assetId: string; mime: string; widthPx: null; heightPx: null };
      expect(payload.mime).toBe('image/svg+xml');
      expect(payload.widthPx).toBeNull();
      expect(payload.heightPx).toBeNull();

      const [, buffer, key, contentType] = uploadToS3Mock.mock.calls[0] as [string, Buffer, string, string];
      expect(key).toBe(`cnc-art/${USER_ID}/${payload.assetId}.svg`);
      expect(contentType).toBe('image/svg+xml');
      expect(buffer.toString('utf8')).toContain('<path d="M10 10 L90 90 Z"/>');

      // The hash on the row is of the STORED bytes, which is the whole reason
      // the sanitiser re-serialises rather than passing the upload through.
      const { sha256 } = createArtAssetMock.mock.calls[0][0] as { sha256: string };
      const { createHash } = await import('node:crypto');
      expect(sha256).toBe(createHash('sha256').update(buffer).digest('hex'));
    } finally {
      await closeServer(server);
    }
  });

  it('refuses an SVG that carries a script, and writes nothing', async () => {
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: SCRIPTED_SVG, type: 'image/svg+xml', name: 'evil.svg' });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { reason: string }).reason).toBe('disallowed_element');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
      expect(createArtAssetMock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a file over the 5 MB cap with a 413', async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0x41);
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: oversized, type: 'image/png', name: 'huge.png' });
      expect(response.status).toBe(413);
      expect(((await response.json()) as { reason: string }).reason).toBe('file_too_large');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a JPEG by its bytes, whatever the part claimed to be', async () => {
    const jpeg = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    const { baseUrl, server } = await startServer();
    try {
      // Declared as an SVG. The declared type is never consulted, so this is
      // still a JPEG and still a 415.
      const response = await postArt(baseUrl, { bytes: jpeg, type: 'image/svg+xml', name: 'logo.svg' });
      expect(response.status).toBe(415);
      expect(((await response.json()) as { reason: string }).reason).toBe('unsupported_type');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a PNG below the minimum size', async () => {
    const tiny = await makePng(32);
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: tiny, type: 'image/png', name: 'tiny.png' });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { reason: string }).reason).toBe('image_too_small');
    } finally {
      await closeServer(server);
    }
  });

  it('401s without a token, and never reads the body', async () => {
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(
        baseUrl,
        { bytes: CLEAN_SVG, type: 'image/svg+xml', name: 'logo.svg' },
        { authorization: null },
      );
      expect(response.status).toBe(401);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
      expect(checkRateLimitRedisMock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('503s when the private bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: CLEAN_SVG, type: 'image/svg+xml', name: 'logo.svg' });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { reason: string }).reason).toBe('storage_unavailable');
      expect(isS3ConfiguredMock).toHaveBeenCalledWith('private');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('429s once the hourly budget is spent', async () => {
    checkRateLimitRedisMock.mockRejectedValue(new RateLimitError(600));
    const { baseUrl, server } = await startServer();
    try {
      const response = await postArt(baseUrl, { bytes: CLEAN_SVG, type: 'image/svg+xml', name: 'logo.svg' });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('600');
      expect(checkRateLimitRedisMock).toHaveBeenCalledWith(USER_ID, 'cncArtUpload', 20, 60 * 60 * 1000);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
