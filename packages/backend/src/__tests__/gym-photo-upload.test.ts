import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const validateTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

const { db } = await import('../db/client');
const { handleGymPhotoUpload, handleGymPhotoDelete, getGymPhotosDir } = await import('../handlers/gym-photos');
const { socialGymQueries, socialGymMutations } = await import('../graphql/resolvers/social/gyms');

/**
 * Real-DB + real-HTTP coverage for POST and DELETE /api/gym-photos. The upload
 * mechanics are shared with the logo and covered exhaustively by
 * gym-logo-upload.test.ts; this file pins what is specific to the photo — the
 * round trip through updateGym's stricter GymPhotoUrlSchema, and the DELETE
 * endpoint's server-enforced "clear the column, then drop the object" contract.
 */

const OWNER = 'gp-owner';
const RANDOM = 'gp-random';
const ALL_USERS = [OWNER, RANDOM];

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

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
  await Promise.all(
    ['jpg', 'png', 'gif', 'webp'].map((ext) => rm(path.join(dir, `${gymUuid}.${ext}`), { force: true })),
  );
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
  await removeUploadedPhotos();
});

describe('POST /api/gym-photos', () => {
  it('stores the photo and the returned path survives updateGym validation', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success?: boolean; photoUrl?: string };
      expect(body.success).toBe(true);
      expect(body.photoUrl).toMatch(new RegExp(`^/static/gym-photos/${gymUuid}\\.jpg\\?v=[0-9a-f-]{36}$`));

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
  it('clears image_url itself rather than trusting the caller to have done it', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startPhotoServer();
    try {
      const uploaded = (await (await uploadPhoto(baseUrl, { token: 'owner', gymUuid })).json()) as {
        photoUrl?: string;
      };
      await socialGymMutations.updateGym(null, { input: { gymUuid, imageUrl: uploaded.photoUrl! } }, authCtx(OWNER));
      const storedPath = path.join(getGymPhotosDir(), `${gymUuid}.jpg`);
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
