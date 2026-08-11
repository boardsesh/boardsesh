import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';

const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const getFromS3Mock = vi.hoisted(() => vi.fn());
const uploadToS3Mock = vi.hoisted(() => vi.fn());

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  getFromS3: getFromS3Mock,
  uploadToS3: uploadToS3Mock,
  deleteUserAvatarsFromS3: vi.fn(),
}));

const { handleStaticBetaThumbnail } = await import('../handlers/static');
const { parseSizeParam } = await import('../lib/image-resize');

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const THUMBNAIL_PATH = '/static/beta-link-thumbnails/instagram/ABC123.jpg';

async function startThumbnailServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const remainder = url.pathname.slice('/static/beta-link-thumbnails/'.length);
    const slashIndex = remainder.indexOf('/');
    void handleStaticBetaThumbnail(
      req,
      res,
      remainder.slice(0, slashIndex),
      remainder.slice(slashIndex + 1),
      parseSizeParam(url.searchParams.get('size')),
    ).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unhandled' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
});

describe('serving beta-link thumbnails stored in S3', () => {
  it('404s a zero-byte object instead of answering 200 with an empty body', async () => {
    // The 200 path is `immutable, max-age=1y`, so an empty body would be
    // pinned in browser and CDN caches with no way to repair it.
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startThumbnailServer();
    try {
      const response = await fetch(`${baseUrl}${THUMBNAIL_PATH}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('still streams a healthy object with the immutable cache header', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([JPEG_BYTES]),
      contentType: 'image/jpeg',
      contentLength: JPEG_BYTES.length,
    });

    const { baseUrl, server } = await startThumbnailServer();
    try {
      const response = await fetch(`${baseUrl}${THUMBNAIL_PATH}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });
});
