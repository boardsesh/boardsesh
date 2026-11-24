import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { gymMembers, gyms } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const validateTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

const { db } = await import('../db/client');
const { handleGymPhotoUpload, handleGymPhotoDelete, getGymPhotosDir } = await import('../handlers/gym-photos');
const { handleStaticGymPhoto } = await import('../handlers/static');
const { socialGymQueries, socialGymMutations } = await import('../graphql/resolvers/social/gyms');
const { reencodeUploadedImage } = await import('../lib/image-resize');
const imageStorage = await import('../services/gym-image-storage');
const { storeVersionedGymImage, removeVersionedGymImage } = imageStorage;
const { runWithDatabaseTransaction } = await import('../db/client');
const { APPENDED_PAYLOAD_MARKER, overPixelCapPng, smallJpeg, withAppendedPayload } =
  await import('./helpers/upload-images');

/**
 * Real-DB + real-HTTP coverage for POST and DELETE /api/gym-photos. The upload
 * mechanics are shared with the logo and covered exhaustively by
 * gym-logo-upload.test.ts; this file pins what is specific to the photo — the
 * round trip through updateGym's stricter GymPhotoUrlSchema, and the DELETE
 * endpoint's server-enforced "clear the column, then drop the object" contract.
 */

const OWNER = 'gp-owner';
const EDITOR = 'gp-editor';
const RANDOM = 'gp-random';
const ALL_USERS = [OWNER, EDITOR, RANDOM];

// A real JPEG: the handler stores sharp's re-encode, so bytes sharp cannot
// read are refused.
const JPEG_BYTES = await smallJpeg();

let gymUuid: string;

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function startPhotoServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/gym-photos' && req.method === 'POST') {
        await handleGymPhotoUpload(req, res);
        return;
      }
      if (url.pathname === '/api/gym-photos' && req.method === 'DELETE') {
        await handleGymPhotoDelete(req, res);
        return;
      }
      if (url.pathname.startsWith('/static/gym-photos/')) {
        await handleStaticGymPhoto(req, res, url.pathname.slice('/static/gym-photos/'.length));
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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function removeUploadedPhotos(): Promise<void> {
  const dir = getGymPhotosDir();
  const fileNames = await readdir(dir).catch(() => []);
  await Promise.all(
    fileNames.filter((fileName) => fileName.startsWith(`${gymUuid}.`)).map((fileName) => rm(path.join(dir, fileName))),
  );
}

function photoFilePath(photoUrl: string): string {
  return new URL(photoUrl, 'https://api.boardsesh.com').pathname.slice('/static/'.length);
}

function uploadPhoto(baseUrl: string, opts: { token?: string; gymUuid?: string; blob?: Blob }): Promise<Response> {
  const formData = new FormData();
  if (opts.gymUuid !== undefined) formData.set('gymUuid', opts.gymUuid);
  formData.set('photo', opts.blob ?? new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'gym-photo.jpg');
  return fetch(`${baseUrl}/api/gym-photos`, {
    method: 'POST',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    body: formData,
  });
}

function deletePhoto(baseUrl: string, opts: { token?: string; gymUuid: string }): Promise<Response> {
  return fetch(`${baseUrl}/api/gym-photos?gymUuid=${encodeURIComponent(opts.gymUuid)}`, {
    method: 'DELETE',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "community_roles", "gym_members", "user_boards", "gyms" RESTART IDENTITY CASCADE
  `);
  vi.clearAllMocks();

  await Promise.all(ALL_USERS.map(insertUser));

  gymUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${gymUuid}, ${'Photo Gym'}, ${gymUuid}, ${OWNER}, true, now(), now())
  `);
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await removeUploadedPhotos();
});

describe('POST /api/gym-photos', () => {
  it('stores and attaches the photo before returning its gym and versioned URL', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success?: boolean; photoUrl?: string; gym: { imageUrl: string } };
      expect(body.success).toBe(true);
      expect(body.photoUrl).toMatch(new RegExp(`^/static/gym-photos/${gymUuid}\\.[0-9a-f-]{36}\\.jpg$`));
      expect(body.gym.imageUrl).toBe(body.photoUrl);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBe(body.photoUrl);

      // The whole point of GymPhotoUrlSchema: the path our own uploader just
      // returned must round-trip through the mutation, or every upload would
      // orphan the object it stored.
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: body.photoUrl! } }, authCtx(OWNER));
      const gym = await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER));
      expect(gym!.imageUrl).toBe(body.photoUrl);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a caller with no edit access (403)', async () => {
    validateTokenMock.mockResolvedValue({ userId: RANDOM });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'random', gymUuid });
      expect(response.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('writes a re-encode to disk, not a payload appended after a real JPEG', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([withAppendedPayload(JPEG_BYTES)], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(200);

      const uploaded = (await response.json()) as { photoUrl: string };
      const written = await readFile(photoFilePath(uploaded.photoUrl));
      expect(written.includes(APPENDED_PAYLOAD_MARKER)).toBe(false);
      expect(written).toEqual(await reencodeUploadedImage(JPEG_BYTES, 'image/jpeg'));
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a small PNG whose pixels exceed the decode cap (400) and writes nothing', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([overPixelCapPng()], { type: 'image/png' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'File is not a readable image' });
      await expect(access(path.join(getGymPhotosDir(), `${gymUuid}.png`))).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('refuses JPEG magic bytes sharp cannot decode instead of storing them (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9])], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'File is not a readable image' });
      await expect(access(path.join(getGymPhotosDir(), `${gymUuid}.jpg`))).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('leaves the stored photo untouched when a later upload is refused', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const first = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
      });
      expect(first.status).toBe(200);
      const uploaded = (await first.json()) as { photoUrl: string };
      const storedPath = photoFilePath(uploaded.photoUrl);
      const stored = await readFile(storedPath);

      const refused = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9])], { type: 'image/jpeg' }),
      });
      expect(refused.status).toBe(400);
      expect(await readFile(storedPath)).toEqual(stored);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects bytes that contradict the declared image type (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([Buffer.from('not an image at all', 'latin1')], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

describe('DELETE /api/gym-photos', () => {
  it.each(['legacy', 'versioned'])(
    'preserves the current %s photo across cache-version updates',
    async (storageKind) => {
      const originalUrl =
        storageKind === 'legacy'
          ? `/static/gym-photos/${gymUuid}.jpg?v=a`
          : await storeVersionedGymImage(gymUuid, 'photo', JPEG_BYTES, 'image/jpeg');
      const storedPath = photoFilePath(originalUrl);
      await mkdir(getGymPhotosDir(), { recursive: true });
      await writeFile(storedPath, JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: originalUrl } }, authCtx(OWNER));
      const restampedUrl = `/static/${storedPath}?v=b`;
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: restampedUrl } }, authCtx(OWNER));
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBe(restampedUrl);
      expect(await readFile(storedPath)).toEqual(JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: null } }, authCtx(OWNER));
      await expect(access(storedPath)).rejects.toThrow();
    },
  );

  it('removes a legacy web photo only after the delegated clear commits', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { server } = await startPhotoServer();
    try {
      const storedPath = path.join(getGymPhotosDir(), `${gymUuid}.jpg`);
      const legacyUrl = `/static/gym-photos/${gymUuid}.jpg?v=old-web-upload`;
      await mkdir(getGymPhotosDir(), { recursive: true });
      await writeFile(storedPath, JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: legacyUrl } }, authCtx(OWNER));
      await expect(
        runWithDatabaseTransaction(async () => {
          await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: null } }, authCtx(OWNER));
          await access(storedPath);
          throw new Error('The receipt could not commit');
        }),
      ).rejects.toThrow('receipt');
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBe(legacyUrl);
      await access(storedPath);
      await runWithDatabaseTransaction(async () => {
        await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: null } }, authCtx(OWNER));
      });
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBeNull();
      await expect(access(storedPath)).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('keeps a prepared web replacement when an assistant clears the previous legacy photo', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const legacyUrl = `/static/gym-photos/${gymUuid}.jpg?v=old-web-upload`;
      await mkdir(getGymPhotosDir(), { recursive: true });
      await writeFile(photoFilePath(legacyUrl), JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: legacyUrl } }, authCtx(OWNER));
      vi.spyOn(imageStorage, 'storeVersionedGymImage').mockImplementationOnce(async (...arguments_) => {
        const preparedUrl = await storeVersionedGymImage(...arguments_);
        await runWithDatabaseTransaction(async () => {
          await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: null } }, authCtx(OWNER));
        });
        await expect(access(photoFilePath(legacyUrl))).rejects.toThrow();
        await access(photoFilePath(preparedUrl));
        return preparedUrl;
      });
      const uploaded = (await (await uploadPhoto(baseUrl, { token: 'owner', gymUuid })).json()) as {
        photoUrl: string;
      };
      expect(photoFilePath(uploaded.photoUrl)).not.toBe(photoFilePath(legacyUrl));
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBe(uploaded.photoUrl);
      const response = await fetch(`${baseUrl}${uploaded.photoUrl}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await reencodeUploadedImage(JPEG_BYTES, 'image/jpeg'));
    } finally {
      await closeServer(server);
    }
  });

  it('discards the prepared image if gym authority disappears before attachment', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    let preparedUrl: string | undefined;
    try {
      vi.spyOn(imageStorage, 'storeVersionedGymImage').mockImplementationOnce(async (...arguments_) => {
        preparedUrl = await storeVersionedGymImage(...arguments_);
        await db.update(gyms).set({ ownerId: RANDOM }).where(eq(gyms.uuid, gymUuid));
        return preparedUrl;
      });
      expect((await uploadPhoto(baseUrl, { token: 'owner', gymUuid })).status).toBe(403);
      expect(preparedUrl).toBeDefined();
      await expect(access(photoFilePath(preparedUrl!))).rejects.toThrow();
      const [currentGym] = await db.select({ imageUrl: gyms.imageUrl }).from(gyms).where(eq(gyms.uuid, gymUuid));
      expect(currentGym!.imageUrl).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('allows concurrent editor removals without requiring extra pool connections', async () => {
    validateTokenMock.mockResolvedValue({ userId: EDITOR });
    const [gym] = await db.select({ id: gyms.id }).from(gyms).where(eq(gyms.uuid, gymUuid)).limit(1);
    await db.insert(gymMembers).values({ gymId: gym!.id, userId: EDITOR, role: 'editor' });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => deletePhoto(baseUrl, { token: 'editor', gymUuid })),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    } finally {
      await closeServer(server);
    }
  });

  it('removes an immutable MCP photo through the regular gym delete endpoint', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const storedUrl = await storeVersionedGymImage(gymUuid, 'photo', JPEG_BYTES, 'image/jpeg');
    const storedPath = storedUrl.slice('/static/'.length);
    const { baseUrl, server } = await startPhotoServer();
    try {
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: storedUrl } }, authCtx(OWNER));
      expect((await deletePhoto(baseUrl, { token: 'owner', gymUuid })).status).toBe(200);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBeNull();
      await expect(access(storedPath)).rejects.toThrow();
    } finally {
      await closeServer(server);
      await removeVersionedGymImage(gymUuid, 'photo', storedUrl);
    }
  });

  it('preserves a live photo when a delegated outer transaction rolls back', async () => {
    const originalUrl = await storeVersionedGymImage(gymUuid, 'photo', JPEG_BYTES, 'image/jpeg');
    const replacementUrl = await storeVersionedGymImage(gymUuid, 'photo', JPEG_BYTES, 'image/jpeg');
    try {
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: originalUrl } }, authCtx(OWNER));
      await expect(
        runWithDatabaseTransaction(async () => {
          await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: replacementUrl } }, authCtx(OWNER));
          throw new Error('The mutation receipt could not commit');
        }),
      ).rejects.toThrow('mutation receipt');
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.imageUrl).toBe(originalUrl);
      await access(originalUrl.slice('/static/'.length));
      await runWithDatabaseTransaction(async () => {
        await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: replacementUrl } }, authCtx(OWNER));
      });
      await expect(access(originalUrl.slice('/static/'.length))).rejects.toThrow();
      await access(replacementUrl.slice('/static/'.length));
    } finally {
      await removeVersionedGymImage(gymUuid, 'photo', originalUrl);
      await removeVersionedGymImage(gymUuid, 'photo', replacementUrl);
    }
  });

  it('reads its query string when the Host header is empty', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    const request = {
      method: 'DELETE',
      url: '/api/gym-photos?gymUuid=not-a-uuid',
      headers: { host: '', authorization: 'Bearer owner' },
    };

    await handleGymPhotoDelete(request as never, response as never);

    expect(response.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Invalid gymUuid format' }));
  });

  it('clears image_url itself rather than trusting the caller to have done it', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const uploaded = (await (await uploadPhoto(baseUrl, { token: 'owner', gymUuid })).json()) as {
        photoUrl?: string;
      };
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: uploaded.photoUrl! } }, authCtx(OWNER));
      const storedPath = photoFilePath(uploaded.photoUrl!);
      await access(storedPath);

      // Deliberately NOT preceded by updateGym(imageUrl: null) — a direct API
      // caller in the wrong order must not be able to leave the row pointing at
      // a deleted object.
      const response = await deletePhoto(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);

      const gym = await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER));
      expect(gym!.imageUrl).toBeNull();
      await expect(access(storedPath)).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('is a no-op success when the gym has no photo', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await deletePhoto(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      const gym = await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER));
      expect(gym!.imageUrl).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('requires authentication (401) and edit access (403)', async () => {
    const { baseUrl, server } = await startPhotoServer();
    try {
      expect((await deletePhoto(baseUrl, { gymUuid })).status).toBe(401);

      validateTokenMock.mockResolvedValue({ userId: RANDOM });
      expect((await deletePhoto(baseUrl, { token: 'random', gymUuid })).status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a malformed gymUuid before it can become a storage key (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      expect((await deletePhoto(baseUrl, { token: 'owner', gymUuid: '../../etc/passwd' })).status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});
