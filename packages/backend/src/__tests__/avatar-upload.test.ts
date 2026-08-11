import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  for (const ext of ['jpg', 'png', 'gif', 'webp']) {
    await rm(path.join(getAvatarsDir(), `${USER_ID}.${ext}`), { force: true });
  }
}

async function uploadAvatar(baseUrl: string, blob: Blob, fileName: string): Promise<Response> {
  const formData = new FormData();
  formData.set('userId', USER_ID);
  formData.set('avatar', blob, fileName);
  return fetch(`${baseUrl}/api/avatars`, {
    method: 'POST',
    headers: { Authorization: 'Bearer avatar-token' },
    body: formData,
  });
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

  it('re-uploading at a different extension removes the stale file and serves the new one', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      const jpegResponse = await uploadAvatar(baseUrl, new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg');
      expect(jpegResponse.status).toBe(200);

      const pngResponse = await uploadAvatar(baseUrl, new Blob([PNG_BYTES], { type: 'image/png' }), 'avatar.png');
      expect(pngResponse.status).toBe(200);
      const pngBody = (await pngResponse.json()) as { avatarUrl?: string };
      expect(pngBody.avatarUrl).toMatch(/\.png\?v=/);

      const staticResponse = await fetch(`${baseUrl}${pngBody.avatarUrl}`);
      expect(staticResponse.status).toBe(200);
      expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(PNG_BYTES);

      // The stale .jpg from the first upload must be cleaned up.
      await expect(access(path.join(getAvatarsDir(), `${USER_ID}.jpg`))).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('concurrent cross-extension uploads leave exactly one avatar (never zero)', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      // Unserialized, each request writes its own file and then deletes the
      // other's fresh one — both 200 with zero files left on disk.
      const [jpegResponse, pngResponse] = await Promise.all([
        uploadAvatar(baseUrl, new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg'),
        uploadAvatar(baseUrl, new Blob([PNG_BYTES], { type: 'image/png' }), 'avatar.png'),
      ]);
      expect(jpegResponse.status).toBe(200);
      expect(pngResponse.status).toBe(200);

      const survivors = (await readdir(getAvatarsDir())).filter((fileName) => fileName.startsWith(USER_ID));
      expect(survivors).toHaveLength(1);

      // The surviving file must be one of the two that were just uploaded and
      // must actually serve.
      const survivorExt = path.extname(survivors[0]).slice(1);
      expect(['jpg', 'png']).toContain(survivorExt);
      const survivorBody = survivorExt === 'jpg' ? await jpegResponse.json() : await pngResponse.json();
      const { avatarUrl } = survivorBody as { avatarUrl: string };
      const staticResponse = await fetch(`${baseUrl}${avatarUrl}`);
      expect(staticResponse.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects an empty file part and leaves the existing avatar alone', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      const jpegResponse = await uploadAvatar(baseUrl, new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg');
      expect(jpegResponse.status).toBe(200);
      const jpegBody = (await jpegResponse.json()) as { avatarUrl?: string };

      const emptyResponse = await uploadAvatar(baseUrl, new Blob([], { type: 'image/png' }), 'avatar.png');

      expect(emptyResponse.status).toBe(400);
      expect((await emptyResponse.json()) as { error?: string }).toEqual({ error: 'Uploaded file is empty' });

      // Nothing new written, and the avatar the stored URL points at survives.
      await expect(access(path.join(getAvatarsDir(), `${USER_ID}.png`))).rejects.toThrow();
      const staticResponse = await fetch(`${baseUrl}${jpegBody.avatarUrl}`);
      expect(staticResponse.status).toBe(200);
      expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });

  it('serves 404 (uncacheable) for a zero-byte avatar file instead of an empty 200', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      await mkdir(getAvatarsDir(), { recursive: true });
      await writeFile(path.join(getAvatarsDir(), `${USER_ID}.jpg`), Buffer.alloc(0));

      const staticResponse = await fetch(`${baseUrl}/static/avatars/${USER_ID}.jpg`);

      expect(staticResponse.status).toBe(404);
      expect(staticResponse.headers.get('cache-control')).toBe('no-store');
    } finally {
      await closeServer(server);
    }
  });

  it('a failed replacement upload preserves the existing avatar (write-first, clean-after)', async () => {
    validateTokenMock.mockResolvedValue({ userId: USER_ID });
    const { baseUrl, server } = await startAvatarServer();
    try {
      const jpegResponse = await uploadAvatar(baseUrl, new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'avatar.jpg');
      expect(jpegResponse.status).toBe(200);
      const jpegBody = (await jpegResponse.json()) as { avatarUrl?: string };

      // Force the .png write to fail by occupying its path with a directory.
      const blockingDir = path.join(getAvatarsDir(), `${USER_ID}.png`);
      await mkdir(blockingDir);

      try {
        const pngResponse = await uploadAvatar(baseUrl, new Blob([PNG_BYTES], { type: 'image/png' }), 'avatar.png');
        expect(pngResponse.status).toBe(500);

        // The previously uploaded avatar the stored avatarUrl points at must survive.
        const staticResponse = await fetch(`${baseUrl}${jpegBody.avatarUrl}`);
        expect(staticResponse.status).toBe(200);
        expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(JPEG_BYTES);
      } finally {
        await rm(blockingDir, { recursive: true, force: true });
      }
    } finally {
      await closeServer(server);
    }
  });
});
