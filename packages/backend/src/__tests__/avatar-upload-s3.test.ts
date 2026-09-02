import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn());
const uploadToS3Mock = vi.hoisted(() => vi.fn());
const deleteUserAvatarsFromS3Mock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
  deleteUserAvatarsFromS3: deleteUserAvatarsFromS3Mock,
}));

const { handleAvatarUpload } = await import('../handlers/avatars');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

async function startAvatarServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
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
    uploadToS3Mock.mockImplementation(async () => {
      callOrder.push('upload');
    });
    deleteUserAvatarsFromS3Mock.mockImplementation(async () => {
      callOrder.push('delete');
    });

    const { baseUrl, server } = await startAvatarServer();
    try {
      const response = await uploadJpegAvatar(baseUrl);

      expect(response.status).toBe(200);
      expect(callOrder).toEqual(['upload', 'delete']);
      expect(uploadToS3Mock).toHaveBeenCalledWith('media', expect.any(Buffer), `avatars/${USER_ID}.jpg`, 'image/jpeg');
      // keepExt must match the freshly written file so it is never deleted.
      expect(deleteUserAvatarsFromS3Mock).toHaveBeenCalledWith(USER_ID, 'jpg');
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
