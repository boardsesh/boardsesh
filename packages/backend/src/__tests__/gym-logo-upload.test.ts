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

// Pass-through wrapper around the real storage module with per-test control
// switches, so the S3 code path (unreachable in the test env, which has no S3
// configured) can be exercised without real S3: `forceS3` flips isS3Configured,
// `uploadError` makes uploadToS3 fail, and every stale-logo cleanup call is
// recorded to assert write-first ordering.
const s3Control = vi.hoisted(() => ({
  forceS3: false,
  uploadError: null as Error | null,
  deleteCalls: [] as Array<{ gymUuid: string; keepExt?: string }>,
}));

vi.mock('../storage/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/s3')>();
  return {
    ...actual,
    isS3Configured: () => s3Control.forceS3 || actual.isS3Configured(),
    uploadToS3: async (...args: Parameters<typeof actual.uploadToS3>) => {
      if (s3Control.uploadError) throw s3Control.uploadError;
      if (s3Control.forceS3) return { url: `stub://${args[1]}`, key: args[1] }; // never touch real S3 from tests
      return actual.uploadToS3(...args);
    },
    deleteGymLogosFromS3: async (targetGymUuid: string, keepExt?: string) => {
      s3Control.deleteCalls.push({ gymUuid: targetGymUuid, keepExt });
      if (s3Control.forceS3) return; // never touch real S3 from tests
      return actual.deleteGymLogosFromS3(targetGymUuid, keepExt);
    },
  };
});

const { db } = await import('../db/client');
const { handleGymLogoUpload, getGymLogosDir } = await import('../handlers/gym-logos');
const { handleStaticGymLogo } = await import('../handlers/static');
const { parseSizeParam } = await import('../lib/image-resize');
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

// Real magic bytes for each format: the handler sniffs the payload and rejects
// anything whose header contradicts the declared multipart Content-Type.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

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
  await Promise.all(
    ['jpg', 'png', 'gif', 'webp'].map((ext) => rm(path.join(dir, `${gymUuid}.${ext}`), { force: true })),
  );
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
  vi.clearAllMocks();
  s3Control.forceS3 = false;
  s3Control.uploadError = null;
  s3Control.deleteCalls = [];
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

  it('lets the gym owner upload a logo, serves it, and it persists via updateGym', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success?: boolean; logoUrl?: string };
      expect(body.success).toBe(true);
      expect(body.logoUrl).toMatch(new RegExp(`^/static/gym-logos/${gymUuid}\\.jpg\\?v=[0-9a-f-]{36}$`));

      // The static route serves the uploaded bytes back.
      const staticResponse = await fetch(`${baseUrl}${body.logoUrl}`);
      expect(staticResponse.status).toBe(200);
      expect(Buffer.from(await staticResponse.arrayBuffer())).toEqual(JPEG_BYTES);

      // And the returned static path passes updateGym's logo validation + persists.
      await socialGymMutations.updateGym(null, { input: { gymUuid, logoUrl: body.logoUrl! } }, authCtx(OWNER));
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

  it('cleans up the stale old-extension file after an extension-switch re-upload', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    const { baseUrl, server } = await startLogoServer();
    try {
      const jpegResponse = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(jpegResponse.status).toBe(200);
      const jpgPath = path.join(getGymLogosDir(), `${gymUuid}.jpg`);
      await access(jpgPath); // old jpg exists

      const pngResponse = await uploadLogo(baseUrl, {
        token: 'owner',
        gymUuid,
        blob: new Blob([PNG_BYTES], { type: 'image/png' }),
        fileName: 'logo.png',
      });
      expect(pngResponse.status).toBe(200);
      const pngBody = (await pngResponse.json()) as { logoUrl?: string };
      expect(pngBody.logoUrl).toContain(`.png`);

      // New png is served; stale jpg was removed after the successful write.
      const staticResponse = await fetch(`${baseUrl}${pngBody.logoUrl}`);
      expect(staticResponse.status).toBe(200);
      await expect(access(jpgPath)).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it('preserves the existing logo when the replacement upload fails (S3 write-first ordering)', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    s3Control.forceS3 = true;
    s3Control.uploadError = new Error('s3 unavailable');
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(500);
      // The stale-logo cleanup must never run before the new object is written —
      // a failed replacement leaves the existing logo (and its stored logoUrl)
      // fully intact.
      expect(s3Control.deleteCalls).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('cleans up other extensions only after a successful S3 write, keeping the new one', async () => {
    validateTokenMock.mockResolvedValue({ userId: OWNER });
    s3Control.forceS3 = true; // upload succeeds via the stub; cleanup is recorded, not executed
    const { baseUrl, server } = await startLogoServer();
    try {
      const response = await uploadLogo(baseUrl, { token: 'owner', gymUuid });
      expect(response.status).toBe(200);
      // Exactly one cleanup, after the write, preserving the new extension.
      expect(s3Control.deleteCalls).toEqual([{ gymUuid, keepExt: 'jpg' }]);
    } finally {
      await closeServer(server);
    }
  });
});
