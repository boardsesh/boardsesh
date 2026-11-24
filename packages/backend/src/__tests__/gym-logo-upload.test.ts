import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, Gym } from '@boardsesh/shared-schema';

const validateTokenMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

// Pass-through wrapper around the real storage module with per-test control
// switches, so the S3 code path (unreachable in the test env, which has no S3
// configured) can be exercised without real S3: `forceS3` flips isS3Configured,
// `uploadError` makes uploadToS3 fail, and every stale-logo cleanup call is
// recorded to assert write-first ordering.
const s3Control = vi.hoisted(() => ({
  forceS3: false,
  uploadError: null as Error | null,
  deleteCalls: [] as Array<{ gymUuid: string; keepExt?: string }>,
  deleteObjectCalls: [] as string[],
  uploads: [] as Array<{ key: string; body: Buffer }>,
}));

vi.mock('../storage/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/s3')>();
  return {
    ...actual,
    isS3Configured: () => s3Control.forceS3 || actual.isS3Configured(),
    uploadToS3: async (...args: Parameters<typeof actual.uploadToS3>) => {
      if (s3Control.uploadError) throw s3Control.uploadError;
      if (s3Control.forceS3) {
        s3Control.uploads.push({ key: args[2], body: args[1] });
        return { url: `stub://${args[2]}`, key: args[2] }; // never touch real S3 from tests
      }
      return actual.uploadToS3(...args);
    },
    deleteGymLogosFromS3: async (targetGymUuid: string, keepExt?: string) => {
      s3Control.deleteCalls.push({ gymUuid: targetGymUuid, keepExt });
      if (s3Control.forceS3) return; // never touch real S3 from tests
      return actual.deleteGymLogosFromS3(targetGymUuid, keepExt);
    },
    deleteFromS3: async (...args: Parameters<typeof actual.deleteFromS3>) => {
      if (s3Control.forceS3) {
        s3Control.deleteObjectCalls.push(args[1]);
        return;
      }
      return actual.deleteFromS3(...args);
    },
  };
});

const { db, runWithDatabaseTransaction } = await import('../db/client');
const imageStorage = await import('../services/gym-image-storage');
const { storeVersionedGymImage } = imageStorage;
const { handleGymLogoUpload, getGymLogosDir } = await import('../handlers/gym-logos');
const { handleStaticGymLogo } = await import('../handlers/static');
const { ALLOWED_IMAGE_SIZES, parseSizeParam, reencodeUploadedImage } = await import('../lib/image-resize');
const { APPENDED_PAYLOAD_MARKER, overPixelCapPng, smallJpeg, smallPng, withAppendedPayload } =
  await import('./helpers/upload-images');
const { socialGymQueries, socialGymMutations } = await import('../graphql/resolvers/social/gyms');

/**
 * Real-DB + real-HTTP coverage for POST /api/gym-logos. Mirrors
 * avatar-upload.test.ts (a live loopback server + fetch/FormData) but seeds
 * gyms/members so the handler's userCanEditGym authorization runs for real. Only
 * `validateToken` is mocked (to stamp the caller's user id without a real JWT).
 */

const OWNER = 'gl-owner';
const ADMIN_MEMBER = 'gl-admin';
const EDITOR_MEMBER = 'gl-editor';
const COMMUNITY_ADMIN = 'gl-community-admin';
const RANDOM = 'gl-random';
const ALL_USERS = [OWNER, ADMIN_MEMBER, EDITOR_MEMBER, COMMUNITY_ADMIN, RANDOM];

// Real, decodable images: the handler sniffs the magic bytes, then stores
// sharp's re-encode, so bytes sharp cannot read are refused.
const JPEG_BYTES = await smallJpeg();
const PNG_BYTES = await smallPng();
// What the handler stores for the JPEG upload above.
const STORED_JPEG_BYTES = await reencodeUploadedImage(JPEG_BYTES, 'image/jpeg');

let gymUuid: string;

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function startLogoServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/gym-logos' && req.method === 'POST') {
        await handleGymLogoUpload(req, res);
        return;
      }
      if (url.pathname.startsWith('/static/gym-logos/') && req.method === 'GET') {
        const fileName = url.pathname.slice('/static/gym-logos/'.length);
        await handleStaticGymLogo(req, res, fileName, parseSizeParam(url.searchParams.get('size')));
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

async function removeUploadedLogos(): Promise<void> {
  const dir = getGymLogosDir();
  const fileNames = await logoFilesForGym();
  await Promise.all(fileNames.map((fileName) => rm(path.join(dir, fileName), { force: true })));
}

async function logoFilesForGym(): Promise<string[]> {
  try {
    // Every test has a fresh gym UUID. Leave all other fixture files alone.
    return (await readdir(getGymLogosDir())).filter((fileName) => fileName.startsWith(`${gymUuid}.`));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function logoStorageKey(logoUrl: string): string {
  const pathname = new URL(logoUrl, 'https://uploads.boardsesh.test').pathname;
  if (!pathname.startsWith(`/static/gym-logos/${gymUuid}.`)) throw new Error('Unexpected uploaded logo path');
  return pathname.slice('/static/'.length);
}

function logoDiskPath(logoUrl: string): string {
  return path.join(getGymLogosDir(), path.basename(logoStorageKey(logoUrl)));
}

async function uploadLogo(
  baseUrl: string,
  opts: { token?: string; gymUuid?: string; blob?: Blob; fileName?: string; omitFile?: boolean },
): Promise<Response> {
  const formData = new FormData();
  if (opts.gymUuid !== undefined) formData.set('gymUuid', opts.gymUuid);
  if (!opts.omitFile) {
    formData.set('logo', opts.blob ?? new Blob([JPEG_BYTES], { type: 'image/jpeg' }), opts.fileName ?? 'logo.jpg');
  }
  return fetch(`${baseUrl}/api/gym-logos`, {
    method: 'POST',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    body: formData,
  });
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "community_roles", "gym_members", "user_boards", "gyms" RESTART IDENTITY CASCADE
  `);
  vi.clearAllMocks();

  await Promise.all(ALL_USERS.map(insertUser));

  gymUuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${gymUuid}, ${'Logo Gym'}, ${gymUuid}, ${OWNER}, true, now(), now())
    RETURNING id
  `);
  const gymId = Number(Array.from(result as Iterable<{ id: number }>)[0].id);
  await db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${ADMIN_MEMBER}, 'admin', now()), (${gymId}, ${EDITOR_MEMBER}, 'editor', now())
  `);
  // Global community admin (board_type NULL) — covers every gym per
  // userCanEditGym's hasGymCommunityAccess branch.
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${COMMUNITY_ADMIN}, 'admin', NULL, now())
  `);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  s3Control.forceS3 = false;
  s3Control.uploadError = null;
  s3Control.deleteCalls = [];
  s3Control.deleteObjectCalls = [];
  s3Control.uploads = [];
  await removeUploadedLogos();
});

describe('POST /api/gym-logos', () => {
  it('requires an Authorization header', async () => {
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { gymUuid });
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects an invalid/expired token', async () => {
    validateTokenMock.mockResolvedValue(null);
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'bad', gymUuid });
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it('commits the owner logo attachment and returns the saved gym', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; logoUrl: string; gym: Gym };
      expect(body.success).toBe(true);
      expect(body.logoUrl).toMatch(
        new RegExp(`^/static/gym-logos/${gymUuid}\\.[0-9a-f-]{36}\\.jpg(?:\\?v=[0-9a-f-]{36})?$`),
      );

      // The static route serves the stored re-encode back.
      const staticResponse = await fetch(`${baseUrl}${body.logoUrl}`);
      expect(staticResponse.status).toBe(200);
      expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(STORED_JPEG_BYTES);

      expect(body.gym.uuid).toBe(gymUuid);
      expect(body.gym.logoUrl).toBe(body.logoUrl);
      // The POST attaches the URL without another client mutation.
      const gym = await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER));
      expect(gym!.logoUrl).toBe(body.logoUrl);
    } finally {
      await closeServer(server);
    }
  });

  it('allows a gym admin member', async () => {
    validateTokenMock.mockResolvedValue({ userId: ADMIN_MEMBER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'admin', gymUuid });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('allows a gym editor member', async () => {
    validateTokenMock.mockResolvedValue({ userId: EDITOR_MEMBER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'editor', gymUuid });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('allows a global community admin (userCanEditGym community branch)', async () => {
    validateTokenMock.mockResolvedValue({ userId: COMMUNITY_ADMIN });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'community-admin', gymUuid });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('forbids a user with no edit access (403)', async () => {
    validateTokenMock.mockResolvedValue({ userId: RANDOM });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'random', gymUuid });
      expect(response.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('404s for an unknown gym', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid: uuidv4() });
      expect(response.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a non-image (SVG) mime type', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        fileName: 'logo.svg',
      });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a file over 2MB', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const oversized = new Blob([Buffer.alloc(2 * 1024 * 1024 + 1, 0)], { type: 'image/png' });
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid, blob: oversized, fileName: 'big.png' });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('requires a gymUuid field', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner' });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a malformed gymUuid (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid: '../../etc/passwd' });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('responds 500 (not a hang / unhandled rejection) when the gym lookup fails', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    // First db.select() inside the finish handler is the gym load — make it blow
    // up like a transient DB outage. Without the try/catch around the authz
    // block this would reject a detached async listener (process-level unhandled
    // rejection) and leave the request hanging forever.
    const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('connection terminated unexpectedly');
    });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe('Failed to authorize gym logo upload');
    } finally {
      selectSpy.mockRestore();
      await closeServer(server);
    }
  });

  it('rejects a path-traversal filename on the static route (400)', async () => {
    const { baseUrl, server } = await startLogoServer();
    try {
      // A fileName containing a separator (sub/logo.jpg → basename mismatch)
      // must be rejected before any fs/S3 access.
      const response = await fetch(`${baseUrl}/static/gym-logos/sub/logo.jpg`);
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a request with no file part (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid, omitFile: true });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe('No file uploaded');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a payload whose bytes contradict the declared image type (400)', async () => {
    // The multipart Content-Type is client-declared. Without a magic-byte check
    // any payload labelled image/png is stored under our key and re-served from
    // our origin as a PNG — arbitrary file hosting for anyone with edit access.
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1')], { type: 'image/png' }),
        fileName: 'logo.png',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe('File contents do not match the declared image type');
    } finally {
      await closeServer(server);
    }
  });

  it('writes a re-encode to disk, not a payload appended after a real JPEG', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const smuggled = withAppendedPayload(JPEG_BYTES);
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([smuggled], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(200);
      const { logoUrl } = (await response.json()) as { logoUrl: string };
      const written = await readFile(logoDiskPath(logoUrl));
      expect(written.includes(APPENDED_PAYLOAD_MARKER)).toBe(false);
      expect(written).toEqual(STORED_JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });

  it('stores a re-encode at the base and every variant key in S3, not the appended payload', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    s3Control.forceS3 = true;
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([withAppendedPayload(JPEG_BYTES)], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(200);
      const { logoUrl } = (await response.json()) as { logoUrl: string };
      const storageKey = logoStorageKey(logoUrl);

      expect(s3Control.uploads).toHaveLength(ALLOWED_IMAGE_SIZES.length + 1);
      for (const { body } of s3Control.uploads) {
        expect(body.includes(APPENDED_PAYLOAD_MARKER)).toBe(false);
      }
      expect(s3Control.uploads.map(({ key }) => key).sort()).toEqual(
        [storageKey, ...ALLOWED_IMAGE_SIZES.map((size) => `${storageKey}@${size}.jpg`)].sort(),
      );
      const base = s3Control.uploads.find(({ key }) => key === storageKey);
      expect(base?.body).toEqual(STORED_JPEG_BYTES);
    } finally {
      await closeServer(server);
    }
  });

  it('refuses JPEG magic bytes sharp cannot decode instead of storing them (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    s3Control.forceS3 = true;
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9])], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'File is not a readable image' });
      expect(s3Control.uploads).toEqual([]);
      expect(s3Control.deleteCalls).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('refuses a small PNG whose pixels exceed the decode cap (400) and writes nothing', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([overPixelCapPng()], { type: 'image/png' }),
        fileName: 'logo.png',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'File is not a readable image' });
      expect(await logoFilesForGym()).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a zero-byte file (400)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([], { type: 'image/png' }),
        fileName: 'empty.png',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe('Uploaded file is empty');
    } finally {
      await closeServer(server);
    }
  });

  it('replaces a different extension and removes the old logo after a successful POST', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const jpegResponse = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(jpegResponse.status).toBe(200);
      const jpegBody = (await jpegResponse.json()) as { logoUrl: string };
      const jpgPath = logoDiskPath(jpegBody.logoUrl);
      await access(jpgPath);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(jpegBody.logoUrl);
      expect((await fetch(`${baseUrl}${jpegBody.logoUrl}`)).status).toBe(200);

      const pngResponse = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([PNG_BYTES], { type: 'image/png' }),
        fileName: 'logo.png',
      });
      expect(pngResponse.status).toBe(200);
      const pngBody = (await pngResponse.json()) as { logoUrl: string; gym: Gym };
      expect(pngBody.logoUrl).toContain(`.png`);
      expect(pngBody.gym.logoUrl).toBe(pngBody.logoUrl);
      const staticResponse = await fetch(`${baseUrl}${pngBody.logoUrl}`);
      expect(staticResponse.status).toBe(200);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(pngBody.logoUrl);
      await vi.waitFor(async () => {
        await expect(access(jpgPath)).rejects.toThrow();
      });
      expect((await fetch(`${baseUrl}${pngBody.logoUrl}`)).status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it.each(['legacy', 'versioned'])(
    'preserves the current %s logo across cache-version updates',
    async (storageKind) => {
      const originalUrl =
        storageKind === 'legacy'
          ? `/static/gym-logos/${gymUuid}.jpg?v=a`
          : await imageStorage.storeVersionedGymImage(gymUuid, 'logo', STORED_JPEG_BYTES, 'image/jpeg');
      const storedPath = logoDiskPath(originalUrl);
      await mkdir(getGymLogosDir(), { recursive: true });
      await writeFile(storedPath, STORED_JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: originalUrl } }, authCtx(OWNER));
      const restampedUrl = `${originalUrl.split('?')[0]}?v=b`;
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: restampedUrl } }, authCtx(OWNER));
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(restampedUrl);
      expect(await readFile(storedPath)).toEqual(STORED_JPEG_BYTES);
      const absoluteUrl = `https://api.boardsesh.com${originalUrl.split('?')[0]}?v=c`;
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: absoluteUrl } }, authCtx(OWNER));
      expect(await readFile(storedPath)).toEqual(STORED_JPEG_BYTES);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(absoluteUrl);
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: null } }, authCtx(OWNER));
      await expect(access(storedPath)).rejects.toThrow();
    },
  );

  it('keeps the unique replacement when an assistant clears the previous legacy logo before attachment', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const legacyUrl = `/static/gym-logos/${gymUuid}.jpg?v=old-web-upload`;
      await mkdir(getGymLogosDir(), { recursive: true });
      await writeFile(logoDiskPath(legacyUrl), STORED_JPEG_BYTES);
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: legacyUrl } }, authCtx(OWNER));
      vi.spyOn(imageStorage, 'storeVersionedGymImage').mockImplementationOnce(async (...arguments_) => {
        const preparedUrl = await storeVersionedGymImage(...arguments_);
        // An assistant clears the old pointer after storage, before POST attaches.
        await runWithDatabaseTransaction(async () => {
          await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: null } }, authCtx(OWNER));
        });
        await expect(access(logoDiskPath(legacyUrl))).rejects.toThrow();
        await access(logoDiskPath(preparedUrl));
        return preparedUrl;
      });
      const replacement = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(replacement.status).toBe(200);
      const replacementBody = (await replacement.json()) as { logoUrl: string; gym: Gym };
      expect(logoStorageKey(replacementBody.logoUrl)).not.toBe(logoStorageKey(legacyUrl));
      expect(replacementBody.gym.logoUrl).toBe(replacementBody.logoUrl);
      const servedReplacement = await fetch(`${baseUrl}${replacementBody.logoUrl}`);
      expect(servedReplacement.status).toBe(200);
      expect(Buffer.from(await servedReplacement.arrayBuffer())).toEqual(STORED_JPEG_BYTES);
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(replacementBody.logoUrl);
    } finally {
      await closeServer(server);
    }
  });

  it('preserves the existing logo when the replacement upload fails (S3 write-first ordering)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const original = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(original.status).toBe(200);
      const originalBody = (await original.json()) as { logoUrl: string };
      s3Control.forceS3 = true;
      s3Control.uploadError = new Error('s3 unavailable');
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(500);
      // The stale-logo cleanup must never run before the new object is written —
      // a failed replacement leaves the existing logo (and its stored logoUrl)
      // fully intact.
      expect(s3Control.deleteCalls).toEqual([]);
      expect(s3Control.deleteObjectCalls).not.toContain(logoStorageKey(originalBody.logoUrl));
      await access(logoDiskPath(originalBody.logoUrl));
      expect((await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER)))!.logoUrl).toBe(originalBody.logoUrl);
    } finally {
      await closeServer(server);
    }
  });

  it('does not delete unrelated S3 keys when attaching the first logo', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    s3Control.forceS3 = true; // upload succeeds via the stub; cleanup is recorded, not executed
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      // With no old attachment, no other stored object belongs to this write.
      expect(s3Control.deleteCalls).toEqual([]);
      expect(s3Control.deleteObjectCalls).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
