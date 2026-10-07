import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';

const validateTokenMock = vi.hoisted(() => vi.fn());
const { uploadedObjects, isS3ConfiguredMock, uploadRace } = vi.hoisted(() => ({
  uploadedObjects: [] as Array<{ bucket: string; key: string; body: Buffer; contentType: string; options: unknown }>,
  isS3ConfiguredMock: vi.fn(() => true),
  uploadRace: { onUpload: null as (() => Promise<void>) | null, failDelete: false },
}));

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

// The storage layer is the ONE thing this file stubs: there is no R2 in CI, and
// what is under test is what we hand the bucket — the stripped bytes, the key,
// and the dimensions carried as object metadata.
vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: vi.fn(async (bucket: string, body: Buffer, key: string, contentType: string, options: unknown = {}) => {
    uploadedObjects.push({ bucket, key, body, contentType, options });
    if (!key.includes('@') && uploadRace.onUpload) await uploadRace.onUpload();
    return { key };
  }),
  deleteFromS3: vi.fn(async (_bucket: string, key: string) => {
    if (uploadRace.failDelete) throw new Error('synthetic erase failure');
    const index = uploadedObjects.findIndex((object) => object.key === key);
    if (index >= 0) uploadedObjects.splice(index, 1);
  }),
}));

const { db } = await import('../db/client');
const {
  handleSprayWallPhotoUpload,
  resetSprayWallPhotoRateLimit,
  sprayWallFullPhotoKey,
  sprayWallPhotoKey,
  SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES,
} = await import('../handlers/spray-wall-photos');

/**
 * POST /api/spray-wall-photos, over real HTTP against the real database.
 *
 * The two cases the issue calls out by name are the reason this file exists:
 *
 *  - **EXIF is stripped.** A phone photo of a home spray wall carries GPS tags,
 *    i.e. the owner's street address. `sharp().rotate()` plus a re-encode is what
 *    removes them, and nothing downstream ever gets a second chance — the bytes
 *    in the bucket are the bytes forever.
 *  - **A PNG renamed to `.jpg` is refused.** The declared Content-Type is
 *    whatever the client said; the magic bytes decide.
 *
 * Plus the privacy invariants that make this handler different from the gym one:
 * the `private` bucket, no ACL, no local-disk fallback, and owner-only access.
 */

const OWNER = 'swp-owner';
const STRANGER = 'swp-stranger';
const ALL_USERS = [OWNER, STRANGER];

/** Something only an EXIF reader could find, so its absence is provable. */
const EXIF_MARKER = 'BOARDSESH-EXIF-LEAK-CANARY';

let wallUuid: string;
let wallLayoutId: number;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

/**
 * A landscape JPEG carrying EXIF: an orientation of 6 ("rotate 90° CW") and a
 * text tag standing in for the GPS block.
 *
 * Orientation earns its place twice over — it proves the `rotate()` ran (a 6
 * means the stored image comes out portrait, i.e. dimensions transposed), which
 * is the same call that drops the metadata.
 */
async function exifTaggedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 60, channels: 3, background: '#4488cc' } })
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { ImageDescription: EXIF_MARKER, Copyright: EXIF_MARKER } },
    })
    .jpeg()
    .toBuffer();
}

/**
 * A landscape 5000x2500 JPEG tagged orientation 6, so the stored photo is a
 * 2500x5000 portrait — larger than both caps, and transposed, so a size read
 * before the rotate would show up in every dimension asserted below.
 */
async function largeExifTaggedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 5000, height: 2500, channels: 3, background: '#4488cc' } })
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { ImageDescription: EXIF_MARKER, Copyright: EXIF_MARKER } },
    })
    .jpeg()
    .toBuffer();
}

async function plainPng(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#112233' } })
    .png()
    .toBuffer();
}

async function startServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/spray-wall-photos' && req.method === 'POST') {
        await handleSprayWallPhotoUpload(req, res);
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

function uploadPhoto(
  baseUrl: string,
  opts: {
    token?: string;
    wallUuid?: string;
    bytes?: Buffer;
    mimeType?: string;
    fileName?: string;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const formData = new FormData();
  if (opts.wallUuid !== undefined) formData.set('wallUuid', opts.wallUuid);
  const bytes = opts.bytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
  formData.set(
    'photo',
    new Blob([new Uint8Array(bytes)], { type: opts.mimeType ?? 'image/jpeg' }),
    opts.fileName ?? 'wall.jpg',
  );
  return fetch(`${baseUrl}/api/spray-wall-photos`, {
    method: 'POST',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    body: formData,
    signal: opts.signal,
  });
}

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const started = await startServer();
  baseUrl = started.baseUrl;
  server = started.server;
});

afterEach(async () => {
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  uploadedObjects.length = 0;
});

beforeEach(async () => {
  uploadRace.onUpload = null;
  uploadRace.failDelete = false;
  await db.execute(sql`TRUNCATE TABLE "spray_walls", "user_boards" RESTART IDENTITY CASCADE`);
  await Promise.all(ALL_USERS.map(insertUser));
  uploadedObjects.length = 0;
  isS3ConfiguredMock.mockReturnValue(true);
  // The window is module state, so a test that exhausts it would leak into the next.
  resetSprayWallPhotoRateLimit();
  validateTokenMock.mockImplementation(async (token: string) => ({ userId: token }));

  wallUuid = uuidv4();
  const [{ layout_id: layoutId }] = (await db.execute(sql`
    SELECT nextval('spray_wall_catalog_id_seq')::int AS layout_id
  `)) as unknown as Array<{ layout_id: number }>;
  wallLayoutId = layoutId;

  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
                             is_public, is_unlisted, angle, is_angle_adjustable, has_leds, created_at, updated_at)
    VALUES (${wallUuid}, ${wallUuid}, ${OWNER}, 'spray', ${wallLayoutId}, ${wallLayoutId}, '1', 'Garage wall',
            false, false, 40, false, false, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO spray_walls (board_uuid, layout_id, hold_count) VALUES (${wallUuid}, ${wallLayoutId}, 0)
  `);
});

describe('POST /api/spray-wall-photos', () => {
  it('strips every EXIF tag from a GPS-style tagged photo', async () => {
    const tagged = await exifTaggedJpeg();
    // Guard the fixture: a test that "proves" stripping against an image with no
    // metadata to strip proves nothing.
    const incoming = await sharp(tagged).metadata();
    expect(incoming.exif).toBeDefined();
    expect(tagged.includes(EXIF_MARKER)).toBe(true);

    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: tagged });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { photoId: string; width: number; height: number };

    const base = uploadedObjects.find((object) => object.key === sprayWallPhotoKey(wallUuid, body.photoId));
    expect(base).toBeDefined();

    const stored = await sharp(base!.body).metadata();
    expect(stored.exif).toBeUndefined();
    // Not just "sharp does not report it": the marker is nowhere in the bytes.
    expect(base!.body.includes(EXIF_MARKER)).toBe(false);

    // Orientation 6 means the source was stored rotated, so the reported size is
    // the post-rotate one. Anchors are tapped on these pixels, so a width/height
    // read before the rotate would transpose the whole canonical frame.
    expect(body.width).toBe(60);
    expect(body.height).toBe(120);
    expect(stored.width).toBe(60);
    expect(stored.height).toBe(120);
  });

  it('rejects a PNG renamed to .jpg', async () => {
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/jpeg',
      fileName: 'wall.jpg',
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/do not match/i),
    });
    expect(uploadedObjects).toHaveLength(0);
  });

  it('stores in the PRIVATE bucket, with no ACL and the dimensions as metadata', async () => {
    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: await exifTaggedJpeg() });
    expect(response.status).toBe(200);

    // Every object — the base and its thumbnail variant — goes to `private`.
    // `media` is world-readable under guessable keys, so one stray object there
    // is a home photo on the open internet.
    expect(uploadedObjects.length).toBeGreaterThanOrEqual(2);
    expect(uploadedObjects.every((object) => object.bucket === 'private')).toBe(true);
    // R2 answers `x-amz-acl` with 501 for values it does not support, so the ACL
    // is forced off rather than left to the bucket default.
    expect(uploadedObjects.every((object) => (object.options as { acl?: unknown }).acl === null)).toBe(true);

    const { photoId } = (await response.json()) as { photoId: string };
    const base = uploadedObjects.find((object) => object.key === sprayWallPhotoKey(wallUuid, photoId));
    expect((base!.options as { metadata?: Record<string, string> }).metadata).toEqual({
      width: '60',
      height: '120',
    });
    expect(base!.contentType).toBe('image/jpeg');

    // `uploadToS3` defaults to `public, max-age=31536000, immutable`. On a
    // photograph of somebody's home that would let any shared cache keep serving
    // it for a YEAR — past the 15-minute presign that is the access control, and
    // past the owner flipping the wall private. EVERY object, variants included.
    for (const object of uploadedObjects) {
      expect((object.options as { cacheControl?: string }).cacheControl).toBe('private, no-store');
    }
  });

  it('keys the object under the wall, so a cleanup sweep can enumerate by prefix', async () => {
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(200);
    const { photoId } = (await response.json()) as { photoId: string };
    expect(uploadedObjects.some((object) => object.key === `spray-walls/${wallUuid}/${photoId}.jpg`)).toBe(true);
  });

  it('erases a photo and variant when the wall is deleted during upload', async () => {
    uploadRace.onUpload = async () => {
      await db.execute(
        sql`UPDATE spray_walls SET deleted_at = now(), photos_purged_at = now() WHERE board_uuid = ${wallUuid}`,
      );
    };
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(404);
    expect(uploadedObjects).toEqual([]);
  });

  it('restores a durable purge retry when withdrawn upload cleanup fails', async () => {
    uploadRace.failDelete = true;
    uploadRace.onUpload = async () => {
      await db.execute(
        sql`UPDATE spray_walls SET deleted_at = now(), photos_purged_at = now() WHERE board_uuid = ${wallUuid}`,
      );
    };
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(404);
    const [wall] = (await db.execute(
      sql`SELECT photos_purged_at FROM spray_walls WHERE board_uuid = ${wallUuid}`,
    )) as unknown as Array<{ photos_purged_at: Date | null }>;
    expect(wall.photos_purged_at).toBeNull();
    expect(uploadedObjects).toHaveLength(2);
  });

  it.each([false, true])(
    'cleans up a late upload if its ownership recheck throws (erase fails: %s)',
    async (failDelete) => {
      uploadRace.failDelete = failDelete;
      uploadRace.onUpload = async () => {
        await db.execute(
          sql`UPDATE spray_walls SET deleted_at = now(), photos_purged_at = now() WHERE board_uuid = ${wallUuid}`,
        );
        vi.spyOn(db, 'select').mockImplementationOnce(() => {
          throw new Error('synthetic final ownership lookup failure');
        });
      };
      const response = await uploadPhoto(baseUrl, {
        token: OWNER,
        wallUuid,
        bytes: await plainPng(),
        mimeType: 'image/png',
      });
      expect(response.status).toBe(500);
      expect(uploadedObjects).toHaveLength(failDelete ? 2 : 0);
      if (failDelete) {
        const rows = await db.execute(sql`SELECT photos_purged_at FROM spray_walls WHERE board_uuid = ${wallUuid}`);
        expect(Array.from(rows)[0].photos_purged_at).toBeNull();
      }
      vi.restoreAllMocks();
    },
  );

  it.each([false, true])(
    'preserves the response when erase and retry both fail (lookup throws: %s)',
    async (lookupThrows) => {
      uploadRace.failDelete = true;
      uploadRace.onUpload = async () => {
        await db.execute(
          sql`UPDATE spray_walls SET deleted_at = now(), photos_purged_at = now() WHERE board_uuid = ${wallUuid}`,
        );
        if (lookupThrows)
          vi.spyOn(db, 'select').mockImplementationOnce(() => {
            throw new Error('synthetic ownership lookup failure');
          });
        vi.spyOn(db, 'transaction').mockRejectedValue(new Error('synthetic retry transaction failure'));
      };
      try {
        const response = await uploadPhoto(baseUrl, {
          token: OWNER,
          wallUuid,
          bytes: await plainPng(),
          mimeType: 'image/png',
          signal: AbortSignal.timeout(1500),
        });
        expect(response.status).toBe(lookupThrows ? 500 : 404);
        expect(await response.json()).toMatchObject({
          error: lookupThrows ? 'Failed to save the wall photo' : 'Spray wall not found',
        });
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('refuses a stranger and a missing token', async () => {
    const stranger = await uploadPhoto(baseUrl, {
      token: STRANGER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(stranger.status).toBe(403);

    const anonymous = await uploadPhoto(baseUrl, { wallUuid, bytes: await plainPng(), mimeType: 'image/png' });
    expect(anonymous.status).toBe(401);

    expect(uploadedObjects).toHaveLength(0);
  });

  it('refuses an archived wall, before and after the bytes land, and stores nothing', async () => {
    await db.execute(sql`UPDATE spray_walls SET archived_at = now() WHERE board_uuid = ${wallUuid}`);
    const refused = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('SPRAY_WALL_ARCHIVED');
    expect(uploadedObjects).toHaveLength(0);

    // A reset's first publish archiving the wall while the bytes upload.
    await db.execute(sql`UPDATE spray_walls SET archived_at = NULL WHERE board_uuid = ${wallUuid}`);
    uploadRace.onUpload = async () => {
      await db.execute(sql`UPDATE spray_walls SET archived_at = now() WHERE board_uuid = ${wallUuid}`);
    };
    const raced = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(raced.status).toBe(409);
    expect(uploadedObjects).toEqual([]);
  });

  it('accepts a photo for an unfinished reset clone', async () => {
    const cloneUuid = uuidv4();
    const [{ layout_id: cloneLayoutId }] = (await db.execute(sql`
      SELECT nextval('spray_wall_catalog_id_seq')::int AS layout_id
    `)) as unknown as Array<{ layout_id: number }>;
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
                               is_public, is_unlisted, angle, is_angle_adjustable, has_leds, created_at, updated_at)
      VALUES (${cloneUuid}, ${cloneUuid}, ${OWNER}, 'spray', ${cloneLayoutId}, ${cloneLayoutId}, '1', 'Garage wall',
              false, false, 40, false, false, now(), now())
    `);
    await db.execute(sql`
      INSERT INTO spray_walls (board_uuid, layout_id, hold_count, reset_from_wall_id)
      VALUES (${cloneUuid}, ${cloneLayoutId}, 0, (SELECT id FROM spray_walls WHERE board_uuid = ${wallUuid}))
    `);

    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid: cloneUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(200);
  });

  it('404s an unknown wall without saying whether the uuid is a wall', async () => {
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid: uuidv4(),
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(404);
    expect(uploadedObjects).toHaveLength(0);
  });

  it('rejects a malformed wallUuid before it can reach the key', async () => {
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid: '../../etc/passwd',
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(400);
    expect(uploadedObjects).toHaveLength(0);
  });

  it('refuses a GIF, which the gym handler accepts', async () => {
    // Narrower on purpose: an animated spray wall is not a thing, and dropping
    // the format removes the animated-re-encode question from the sharp step.
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32)]);
    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: gif, mimeType: 'image/gif' });
    expect(response.status).toBe(400);
    expect(uploadedObjects).toHaveLength(0);
  });

  it('answers 501 when the private bucket is not configured, in every environment', async () => {
    // The gym handlers fall back to local disk served from /static; doing that
    // here would put a home photo on an unauthenticated route.
    isS3ConfiguredMock.mockReturnValue(false);
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(501);
    expect(uploadedObjects).toHaveLength(0);
  });

  it('refuses bytes the magic sniff passes but sharp cannot decode', async () => {
    // A truncated JPEG: the right header, nothing behind it. Refusing here is
    // what keeps a version row from pointing at bytes nothing can render.
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]);
    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: truncated });
    expect(response.status).toBe(400);
    expect(uploadedObjects).toHaveLength(0);
  });

  it('caps the upload at 15MB', () => {
    // Raised from 10MB for #5911: the app now sends up to 4096 px, and a busy
    // 4096 px wall photo at JPEG 0.85 runs to 8MB or so.
    expect(SPRAY_WALL_PHOTO_MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
  });

  it('keeps the base at 2048 px and stores a stripped full copy of a larger photo', async () => {
    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: await largeExifTaggedJpeg() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { photoId: string; width: number; height: number };

    // The response and the base metadata carry the BASE size: that is what the
    // canonical frame, the detector and the climb view read, unchanged by #5911.
    expect(body).toMatchObject({ width: 1024, height: 2048 });
    const baseKey = sprayWallPhotoKey(wallUuid, body.photoId);
    const base = uploadedObjects.find((object) => object.key === baseKey);
    expect((base!.options as { metadata?: Record<string, string> }).metadata).toEqual({
      width: '1024',
      height: '2048',
    });
    expect(await sharp(base!.body).metadata()).toMatchObject({ width: 1024, height: 2048 });

    // The full copy: same orientation, capped at 4096 on its long side, and as
    // stripped as the base — it is the SHARPER picture of somebody's home.
    const fullKey = sprayWallFullPhotoKey(baseKey);
    expect(fullKey).toBe(`spray-walls/${wallUuid}/${body.photoId}-full.jpg`);
    const full = uploadedObjects.find((object) => object.key === fullKey);
    expect(full).toBeDefined();
    const fullMetadata = await sharp(full!.body).metadata();
    expect(fullMetadata).toMatchObject({ width: 2048, height: 4096, format: 'jpeg' });
    expect(fullMetadata.exif).toBeUndefined();
    expect(full!.body.includes(EXIF_MARKER)).toBe(false);
    expect(full!.bucket).toBe('private');
    expect(full!.options).toMatchObject({ acl: null, cacheControl: 'private, no-store' });

    // Base last, so a reader that can see the photo can always see its copies.
    expect(uploadedObjects.map((object) => object.key)).toEqual([`${baseKey}@280.jpg`, fullKey, baseKey]);
  });

  it('writes no full copy when the photo already fits the base cap', async () => {
    const response = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: await plainPng(2048, 1536),
      mimeType: 'image/png',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { photoId: string; width: number; height: number };

    expect(body).toMatchObject({ width: 2048, height: 1536 });
    const baseKey = sprayWallPhotoKey(wallUuid, body.photoId);
    expect(uploadedObjects.map((object) => object.key)).toEqual([`${baseKey}@280.jpg`, baseKey]);
  });

  it('erases the full copy too when the wall is deleted during upload', async () => {
    uploadRace.onUpload = async () => {
      await db.execute(
        sql`UPDATE spray_walls SET deleted_at = now(), photos_purged_at = now() WHERE board_uuid = ${wallUuid}`,
      );
    };
    const response = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: await largeExifTaggedJpeg() });
    expect(response.status).toBe(404);
    expect(uploadedObjects).toEqual([]);
  });

  it('spends a per-user budget and then answers 429', async () => {
    // Every POST mints a NEW object (the key carries a fresh uuid) and an
    // abandoned upload is referenced by no row, so nothing else bounds this —
    // `MAX_VERSIONS_PER_WALL` caps the rows, not the uploads that never become one.
    const png = await plainPng();
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await uploadPhoto(baseUrl, {
        token: OWNER,
        wallUuid,
        bytes: png,
        mimeType: 'image/png',
      });
      expect(response.status).toBe(200);
    }

    const overBudget = await uploadPhoto(baseUrl, { token: OWNER, wallUuid, bytes: png, mimeType: 'image/png' });
    expect(overBudget.status).toBe(429);
    expect(overBudget.headers.get('retry-after')).toBe('600');

    // Per user, not global: a second climber is unaffected.
    await db.execute(sql`UPDATE user_boards SET owner_id = ${STRANGER} WHERE uuid = ${wallUuid}`);
    const otherUser = await uploadPhoto(baseUrl, { token: STRANGER, wallUuid, bytes: png, mimeType: 'image/png' });
    expect(otherUser.status).toBe(200);
  });

  it('charges the budget for a REJECTED upload too', async () => {
    // A rejected request still costs a multipart parse and a sharp decode, which
    // is exactly what a spammer would loop on.
    const renamedPng = await plainPng();
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await uploadPhoto(baseUrl, {
        token: OWNER,
        wallUuid,
        bytes: renamedPng,
        mimeType: 'image/jpeg',
      });
      expect(response.status).toBe(400);
    }
    const overBudget = await uploadPhoto(baseUrl, {
      token: OWNER,
      wallUuid,
      bytes: renamedPng,
      mimeType: 'image/png',
    });
    expect(overBudget.status).toBe(429);
  });
});

afterAll(async () => {
  await closeServer(server);
});
