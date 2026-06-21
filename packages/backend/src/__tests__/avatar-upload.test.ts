import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const validateTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

const { handleAvatarUpload, getAvatarsDir } = await import('../handlers/avatars');
const { handleStaticAvatar } = await import('../handlers/static');
const { parseSizeParam } = await import('../lib/image-resize');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

async function startAvatarServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/avatars' && req.method === 'POST') {
        await handleAvatarUpload(req, res);
        return;
      }
      if (url.pathname.startsWith('/static/avatars/') && req.method === 'GET') {
        const fileName = url.pathname.slice('/static/avatars/'.length);
        await handleStaticAvatar(req, res, fileName, parseSizeParam(url.searchParams.get('size')));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    })().catch((error: unknown) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
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

async function removeUploadedAvatar(): Promise<void> {
  await rm(path.join(getAvatarsDir(), `${USER_ID}.jpg`), { force: true });
}

afterEach(async () => {
  vi.clearAllMocks();
  await removeUploadedAvatar();
});

describe('avatar upload routes', () => {
  it('returns a versioned static avatar URL and serves it through the static route', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      const formData = new FormData();
      formData.set('userId', USER_ID);
      formData.set('avatar', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg');

      const uploadResponse = await fetch(`${baseUrl}/api/avatars`, {
        method: 'POST',
        headers: { Authorization: 'Bearer avatar-token' },
        body: formData,
      });

      expect(uploadResponse.status).toBe(200);
      const uploadBody = (await uploadResponse.json()) as { success?: boolean; avatarUrl?: string };
      expect(uploadBody.success).toBe(true);
      expect(uploadBody.avatarUrl).toMatch(
        /^\/static\/avatars\/11111111-1111-4111-8111-111111111111\.jpg\?v=[0-9a-f-]{36}$/,
      );

      const staticResponse = await fetch(`${baseUrl}${uploadBody.avatarUrl}&size=128`);

      expect(staticResponse.status).toBe(200);
      expect(staticResponse.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });
});
