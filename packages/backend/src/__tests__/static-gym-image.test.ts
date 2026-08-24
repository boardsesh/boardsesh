import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// `gym-logo-upload.test.ts` and `gym-photo-upload.test.ts` cover
// `createGymImageUploadHandler` — the write side. Nothing covered the read
// side, so the zero-byte guards inside the shared `serveStaticGymImage` were
// untested. Both `handleStaticGymLogo` and `handleStaticGymPhoto` delegate to
// it, so each guard is exercised through both delegators here.

const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const getFromS3Mock = vi.hoisted(() => vi.fn());
const uploadToS3Mock = vi.hoisted(() => vi.fn());

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  getFromS3: getFromS3Mock,
  uploadToS3: uploadToS3Mock,
  deleteUserAvatarsFromS3: vi.fn(),
  deleteGymLogosFromS3: vi.fn(),
  deleteGymPhotosFromS3: vi.fn(),
}));

const { handleStaticGymLogo, handleStaticGymPhoto } = await import('../handlers/static');
const { getGymLogosDir } = await import('../handlers/gym-logos');
const { getGymPhotosDir } = await import('../handlers/gym-photos');
const { parseSizeParam } = await import('../lib/image-resize');

const GYM_UUID = '33333333-3333-4333-8333-333333333333';
const FILE_NAME = `${GYM_UUID}.jpg`;
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

async function startGymImageServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const size = parseSizeParam(url.searchParams.get('size'));
      if (url.pathname.startsWith('/static/gym-logos/')) {
        await handleStaticGymLogo(req, res, url.pathname.slice('/static/gym-logos/'.length), size);
        return;
      }
      if (url.pathname.startsWith('/static/gym-photos/')) {
        await handleStaticGymPhoto(req, res, url.pathname.slice('/static/gym-photos/'.length), size);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    })().catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unhandled' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  await rm(path.join(getGymLogosDir(), FILE_NAME), { force: true });
  await rm(path.join(getGymPhotosDir(), FILE_NAME), { force: true });
});

describe('serving gym images from S3', () => {
  it('404s a zero-byte gym logo instead of answering 200 with an empty body', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-logos/${FILE_NAME}`);

      expect(response.status).toBe(404);
      // Gym image keys are overwritten in place on re-upload, so a cached 404
      // would pin the broken state past the repair.
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('404s a zero-byte gym photo too, proving both delegators share the guard', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-photos/${FILE_NAME}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('404s a zero-byte object on the ?size= path as well', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-logos/${FILE_NAME}?size=128`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('still streams a healthy gym logo with its one-day cache header', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([JPEG_BYTES]),
      contentType: 'image/jpeg',
      contentLength: JPEG_BYTES.length,
    });

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-logos/${FILE_NAME}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });

  it('leaves an object with an unknown content length streaming', async () => {
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([JPEG_BYTES]),
      contentType: 'image/jpeg',
      contentLength: undefined,
    });

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-logos/${FILE_NAME}`);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });
});

describe('serving gym images from local storage (no S3 configured)', () => {
  it('404s a zero-byte gym logo file on disk', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    await mkdir(getGymLogosDir(), { recursive: true });
    await writeFile(path.join(getGymLogosDir(), FILE_NAME), Buffer.alloc(0));

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-logos/${FILE_NAME}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(getFromS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('still serves a healthy gym photo file on disk', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    await mkdir(getGymPhotosDir(), { recursive: true });
    await writeFile(path.join(getGymPhotosDir(), FILE_NAME), JPEG_BYTES);

    const { baseUrl, server } = await startGymImageServer();
    try {
      const response = await fetch(`${baseUrl}/static/gym-photos/${FILE_NAME}`);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });
});
