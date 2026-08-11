import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ALLOWED_IMAGE_SIZES } from '@boardsesh/shared-schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn());
const uploadToS3Mock = vi.hoisted(() => vi.fn());
const deleteUserAvatarsFromS3Mock = vi.hoisted(() => vi.fn());
const getFromS3Mock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
  deleteUserAvatarsFromS3: deleteUserAvatarsFromS3Mock,
  getFromS3: getFromS3Mock,
}));

const { handleAvatarUpload } = await import('../handlers/avatars');
const { handleStaticAvatar } = await import('../handlers/static');
const { parseSizeParam } = await import('../lib/image-resize');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

async function startAvatarServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/static/avatars/') && req.method === 'GET') {
      const fileName = url.pathname.slice('/static/avatars/'.length);
      void handleStaticAvatar(req, res, fileName, parseSizeParam(url.searchParams.get('size'))).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unhandled' }));
      });
      return;
    }
    void handleAvatarUpload(req, res).catch(() => {
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
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function uploadJpegAvatar(baseUrl: string): Promise<Response> {
  const formData = new FormData();
  formData.set('userId', USER_ID);
  formData.set('avatar', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg');
  return fetch(`${baseUrl}/api/avatars`, {
    method: 'POST',
    headers: { Authorization: 'Bearer avatar-token' },
    body: formData,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('avatar upload S3 path (write-first, clean-after)', () => {
  it('uploads the new avatar before deleting stale extensions', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    isS3ConfiguredMock.mockReturnValue(true);
    const callOrder: string[] = [];
    uploadToS3Mock.mockImplementation(async (_bucket: string, _body: Buffer, key: string) => {
      callOrder.push(key.includes('@') ? 'variant' : 'base');
    });
    deleteUserAvatarsFromS3Mock.mockImplementation(async () => {
      callOrder.push('delete');
    });

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await uploadJpegAvatar(baseUrl);

      expect(response.status).toBe(200);
      // Variants, then the base, then the cleanup. A reader that can see the
      // new avatar can always see its sizes, and nothing stale is removed
      // until the replacement is durably saved.
      const baseIndex = callOrder.indexOf('base');
      expect(callOrder.slice(0, baseIndex).every((entry) => entry === 'variant')).toBe(true);
      expect(callOrder.slice(baseIndex)).toEqual(['base', 'delete']);
      expect(callOrder.filter((entry) => entry === 'variant')).toHaveLength(ALLOWED_IMAGE_SIZES.length);
      expect(uploadToS3Mock).toHaveBeenCalledWith('media', expect.any(Buffer), `avatars/${USER_ID}.jpg`, 'image/jpeg');
      for (const size of ALLOWED_IMAGE_SIZES) {
        expect(uploadToS3Mock).toHaveBeenCalledWith(
          'media',
          expect.any(Buffer),
          `avatars/${USER_ID}.jpg@${size}.jpg`,
          'image/jpeg',
          expect.objectContaining({ cacheControl: expect.any(String) }),
        );
      }
      // keepExt must match the freshly written file so it is never deleted.
      expect(deleteUserAvatarsFromS3Mock).toHaveBeenCalledWith(USER_ID, 'jpg');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects an empty file part without touching S3', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    isS3ConfiguredMock.mockReturnValue(true);

    const { baseUrl, server } = await startAvatarServer();
    try {
      const formData = new FormData();
      formData.set('userId', USER_ID);
      formData.set('avatar', new Blob([], { type: 'image/jpeg' }), 'avatar.jpg');
      const response = await fetch(`${baseUrl}/api/avatars`, {
        method: 'POST',
        headers: { Authorization: 'Bearer avatar-token' },
        body: formData,
      });

      expect(response.status).toBe(400);
      expect((await response.json()) as { error?: string }).toEqual({ error: 'Uploaded file is empty' });
      expect(uploadToS3Mock).not.toHaveBeenCalled();
      expect(deleteUserAvatarsFromS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('never deletes the existing avatar when the S3 upload fails', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    isS3ConfiguredMock.mockReturnValue(true);
    uploadToS3Mock.mockRejectedValue(new Error('S3 unavailable'));

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await uploadJpegAvatar(baseUrl);

      expect(response.status).toBe(500);
      expect(deleteUserAvatarsFromS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});

describe('serving avatars stored in S3', () => {
  it('404s a zero-byte object instead of answering 200 with an empty body', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await fetch(`${baseUrl}/static/avatars/${USER_ID}.jpg`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('404s a zero-byte object on the resize path too', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([]),
      contentType: 'image/jpeg',
      contentLength: 0,
    });

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await fetch(`${baseUrl}/static/avatars/${USER_ID}.jpg?size=128`);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('still streams an object whose length S3 did not report', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([JPEG_BYTES]),
      contentType: 'image/jpeg',
      contentLength: undefined,
    });

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await fetch(`${baseUrl}/static/avatars/${USER_ID}.jpg`);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });
});
