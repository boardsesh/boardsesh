import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { resourcePrivacy, userBoards } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { MAX_KIOSKS_PER_GYM } from '@boardsesh/kiosk';
import { db } from '../db/client';
import { socialGymKioskQueries, socialGymKioskMutations } from '../graphql/resolvers/social/gym-kiosks';
import { requireAnonReadableBoard, requireReadablePresenceBoard } from '../graphql/resolvers/board-presence/shared';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { liveSessionQueries } from '../graphql/resolvers/sessions/live-sessions';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';

/**
 * Real-DB coverage for PR E's gym-kiosk CRUD + public read surface:
 *   - the write gate (owner / gym admin / gym editor allowed; plain member,
 *     stranger, anon rejected) across create / update / delete;
 *   - create slug derivation + per-gym uniqueness (clean error, not a 500) +
 *     the MAX_KIOSKS_PER_GYM cap;
 *   - update layout: strict validation (>4 boards / dup boards / out-of-scope
 *     leaderboard), the alive-and-gym-linked board checks, and parsed-output
 *     persistence (unknown keys stripped in the stored row);
 *   - gymKiosk public read: oldest-kiosk default, private-gym visibility, anon
 *     board filtering, dead-board degradation, lenient corrupt-layout read;
 *   - the gymKiosks manage-list gate.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB, mirroring gym-branding-and-boards.test.ts.
 */

const OWNER = 'gk-owner';
const ADMIN = 'gk-admin';
const EDITOR = 'gk-editor';
const MEMBER = 'gk-member';
const RANDOM = 'gk-random';
const LEADER = 'gk-leader';
const ALL_USERS = [OWNER, ADMIN, EDITOR, MEMBER, RANDOM, LEADER];

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  slug: string;
  isPublic?: boolean;
}): Promise<{ id: number; uuid: string; slug: string }> => {
  const { ownerId, name, slug, isPublic = true } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${slug}, ${ownerId}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, slug };
};

// Each board gets a distinct size_id so the (owner, type, layout, size, set_ids)
// unique constraint never trips across the several boards a single owner has here.
let boardConfigCounter = 0;
const insertBoard = async (opts: {
  gymId: number;
  ownerId: string;
  name: string;
  isPublic: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { gymId, ownerId, name, isPublic } = opts;
  const uuid = uuidv4();
  const sizeId = 10 + boardConfigCounter++;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, ${sizeId}, '1,2', ${name}, ${gymId}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

type KioskLayoutSeed = { version: number; boards: Array<{ boardUuid: string }>; leaderboard: unknown };

const emptyLayoutSeed = (): KioskLayoutSeed => ({ version: 1, boards: [], leaderboard: null });

const insertKiosk = async (opts: {
  gymId: number;
  slug: string;
  name: string;
  layout?: unknown;
  createdAt?: Date;
}): Promise<{ id: number; uuid: string }> => {
  const uuid = uuidv4();
  const layoutJson = JSON.stringify(opts.layout ?? emptyLayoutSeed());
  // Bind the timestamp as an ISO string with an explicit cast — postgres.js
  // rejects a raw JS Date param in a drizzle `sql` template.
  const createdAtIso = (opts.createdAt ?? new Date()).toISOString();
  const result = await db.execute(sql`
    INSERT INTO gym_kiosks (uuid, gym_id, slug, name, layout, created_at, updated_at)
    VALUES (${uuid}, ${opts.gymId}, ${opts.slug}, ${opts.name}, ${layoutJson}::jsonb, ${createdAtIso}::timestamptz, now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

// Public gym owned by OWNER with an admin/editor/member member set; two public
// boards + one private board, all linked. Plus a private gym (OWNER) with a
// single public board.
let publicGym: { id: number; uuid: string; slug: string };
let privateGym: { id: number; uuid: string; slug: string };
let boardPub1: { id: number; uuid: string };
let boardPub2: { id: number; uuid: string };
let boardPriv: { id: number; uuid: string };
let boardInPrivateGym: { id: number; uuid: string };

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_kiosks", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);

  await Promise.all(ALL_USERS.map(insertUser));

  publicGym = await insertGym({ ownerId: OWNER, name: 'Public Gym', slug: 'public-gym' });
  await insertGymMember(publicGym.id, ADMIN, 'admin');
  await insertGymMember(publicGym.id, EDITOR, 'editor');
  await insertGymMember(publicGym.id, MEMBER, 'member');
  boardPub1 = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'A Wall', isPublic: true });
  boardPub2 = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'B Wall', isPublic: true });
  boardPriv = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'C Private Wall', isPublic: false });

  privateGym = await insertGym({ ownerId: OWNER, name: 'Private Gym', slug: 'private-gym', isPublic: false });
  boardInPrivateGym = await insertBoard({
    gymId: privateGym.id,
    ownerId: OWNER,
    name: 'Hidden Wall',
    isPublic: true,
  });
});

// ============================================================================
// CRUD authorization gate matrix
// ============================================================================

describe('kiosk CRUD gate', () => {
  it('lets the owner, a gym admin, and a gym editor create kiosks', async () => {
    for (const [index, viewer] of [OWNER, ADMIN, EDITOR].entries()) {
      const kiosk = await socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: `Wall ${index}`, slug: `wall-${index}` } },
        authCtx(viewer),
      );
      expect(kiosk.uuid).toBeTruthy();
      expect(kiosk.slug).toBe(`wall-${index}`);
    }
  });

  it('rejects create for a plain member, a stranger, and anon', async () => {
    for (const viewer of [MEMBER, RANDOM]) {
      await expect(
        socialGymKioskMutations.createGymKiosk(
          null,
          { input: { gymUuid: publicGym.uuid, name: 'Nope', slug: 'nope' } },
          authCtx(viewer),
        ),
      ).rejects.toThrow();
    }
    await expect(
      socialGymKioskMutations.createGymKiosk(null, { input: { gymUuid: publicGym.uuid, name: 'Nope' } }, anonCtx()),
    ).rejects.toThrow();
  });

  it('gates update + delete the same way, masking authz failures as NOT_FOUND', async () => {
    const seeded = await insertKiosk({ gymId: publicGym.id, slug: 'gated', name: 'Gated' });

    for (const viewer of [MEMBER, RANDOM]) {
      // An authenticated non-editor gets the SAME error (message + extensions)
      // as a missing kiosk — no existence oracle for probers.
      await expect(
        socialGymKioskMutations.updateGymKiosk(
          null,
          { input: { kioskUuid: seeded.uuid, name: 'Renamed' } },
          authCtx(viewer),
        ),
      ).rejects.toMatchObject({ message: 'Kiosk not found', extensions: { code: 'NOT_FOUND' } });
      await expect(
        socialGymKioskMutations.deleteGymKiosk(null, { kioskUuid: seeded.uuid }, authCtx(viewer)),
      ).rejects.toMatchObject({ message: 'Kiosk not found', extensions: { code: 'NOT_FOUND' } });
    }
    await expect(
      socialGymKioskMutations.updateGymKiosk(null, { input: { kioskUuid: seeded.uuid, name: 'X' } }, anonCtx()),
    ).rejects.toThrow();

    // The editor may update; the owner may delete.
    const updated = await socialGymKioskMutations.updateGymKiosk(
      null,
      { input: { kioskUuid: seeded.uuid, name: 'Renamed' } },
      authCtx(EDITOR),
    );
    expect(updated.name).toBe('Renamed');

    const deleted = await socialGymKioskMutations.deleteGymKiosk(null, { kioskUuid: seeded.uuid }, authCtx(OWNER));
    expect(deleted).toBe(true);
    // Gone from the manage list after a soft delete.
    const remaining = await socialGymKioskQueries.gymKiosks(null, { gymUuid: publicGym.uuid }, authCtx(OWNER));
    expect(remaining.find((k) => k.uuid === seeded.uuid)).toBeUndefined();
  });
});

// ============================================================================
// Create: slug derivation, uniqueness, and the per-gym cap
// ============================================================================

describe('createGymKiosk slug + cap', () => {
  it('derives a slug from the name when none is given', async () => {
    const kiosk = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'My Cool Kiosk!' } },
      authCtx(OWNER),
    );
    expect(kiosk.slug).toBe('my-cool-kiosk');
  });

  it('derives a valid slug from a long name whose 50-char cut lands on a hyphen', async () => {
    // 49 a's + ' bcd' → slugified 'aaa…a-bcd' → slice(0, 50) ends in '-' —
    // without the post-slice re-trim the stored slug fails the slug pattern and
    // the kiosk becomes unfetchable by slug.
    const kiosk = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'a'.repeat(49) + ' bcd' } },
      authCtx(OWNER),
    );
    expect(kiosk.slug).toBe('a'.repeat(49));
    expect(kiosk.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    // And the derived slug actually resolves through the public read.
    const fetched = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: kiosk.slug },
      anonCtx(),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.uuid).toBe(kiosk.uuid);
  });

  it('rejects a malformed explicit slug', async () => {
    await expect(
      socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: 'Bad', slug: 'AB' } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });

  it('allows the same slug across two different gyms', async () => {
    const a = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Main', slug: 'main' } },
      authCtx(OWNER),
    );
    const b = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: privateGym.uuid, name: 'Main', slug: 'main' } },
      authCtx(OWNER),
    );
    expect(a.slug).toBe('main');
    expect(b.slug).toBe('main');
  });

  it('rejects a duplicate slug within one gym with a clean error (not a 500)', async () => {
    await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Main', slug: 'main' } },
      authCtx(OWNER),
    );
    await expect(
      socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: 'Main Again', slug: 'main' } },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'KIOSK_SLUG_ALREADY_EXISTS' } });
  });

  it('auto-derives a unique slug when the base name collides', async () => {
    const first = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Front Desk' } },
      authCtx(OWNER),
    );
    const second = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Front Desk' } },
      authCtx(OWNER),
    );
    expect(first.slug).toBe('front-desk');
    expect(second.slug).toBe('front-desk-2');
  });

  it('enforces MAX_KIOSKS_PER_GYM', async () => {
    for (let i = 0; i < MAX_KIOSKS_PER_GYM; i++) {
      await socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: `Kiosk ${i}`, slug: `kiosk-${i}` } },
        authCtx(OWNER),
      );
    }
    await expect(
      socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: 'One Too Many', slug: 'too-many' } },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('serializes concurrent creates at the cap boundary (exactly one wins)', async () => {
    // Seed to one below the cap, then race two creates with distinct slugs.
    // The transactional gym-row lock serializes them: the first insert takes
    // the last slot, the second re-counts and hits BAD_USER_INPUT — never 11.
    for (let i = 0; i < MAX_KIOSKS_PER_GYM - 1; i++) {
      await insertKiosk({ gymId: publicGym.id, slug: `seed-${i}`, name: `Seed ${i}` });
    }

    const outcomes = await Promise.allSettled([
      socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: 'Racer A', slug: 'racer-a' } },
        authCtx(OWNER),
      ),
      socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: 'Racer B', slug: 'racer-b' } },
        authCtx(ADMIN),
      ),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });

    // And the DB really holds exactly MAX_KIOSKS_PER_GYM live kiosks.
    const rows = await db.execute(
      sql`SELECT count(*)::int AS live FROM gym_kiosks WHERE gym_id = ${publicGym.id} AND deleted_at IS NULL`,
    );
    expect(Number(Array.from(rows as Iterable<{ live: number }>)[0].live)).toBe(MAX_KIOSKS_PER_GYM);
  });

  it('frees the slug for reuse after a soft delete', async () => {
    const first = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Reusable', slug: 'reusable' } },
      authCtx(OWNER),
    );
    await socialGymKioskMutations.deleteGymKiosk(null, { kioskUuid: first.uuid }, authCtx(OWNER));

    const second = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Reusable Again', slug: 'reusable' } },
      authCtx(OWNER),
    );
    expect(second.slug).toBe('reusable');
    expect(second.uuid).not.toBe(first.uuid);
  });

  it('frees a MAX_KIOSKS_PER_GYM slot after a soft delete', async () => {
    const created: string[] = [];
    for (let i = 0; i < MAX_KIOSKS_PER_GYM; i++) {
      const kiosk = await socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: publicGym.uuid, name: `Kiosk ${i}`, slug: `kiosk-${i}` } },
        authCtx(OWNER),
      );
      created.push(kiosk.uuid);
    }
    await socialGymKioskMutations.deleteGymKiosk(null, { kioskUuid: created[0] }, authCtx(OWNER));

    const replacement = await socialGymKioskMutations.createGymKiosk(
      null,
      { input: { gymUuid: publicGym.uuid, name: 'Replacement', slug: 'replacement' } },
      authCtx(OWNER),
    );
    expect(replacement.slug).toBe('replacement');
  });
});

// ============================================================================
// Update: strict layout validation + gym-linked board checks + persistence
// ============================================================================

describe('updateGymKiosk layout validation', () => {
  const seedKiosk = () => insertKiosk({ gymId: publicGym.id, slug: 'editable', name: 'Editable' });

  it('rejects a layout with more than four boards', async () => {
    const kiosk = await seedKiosk();
    const boards = Array.from({ length: 5 }, () => ({ boardUuid: uuidv4() }));
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        { input: { kioskUuid: kiosk.uuid, layout: { version: 1, boards, leaderboard: null } } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });

  it('rejects a layout with duplicate boards', async () => {
    const kiosk = await seedKiosk();
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        {
          input: {
            kioskUuid: kiosk.uuid,
            layout: {
              version: 1,
              boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPub1.uuid }],
              leaderboard: null,
            },
          },
        },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });

  it('rejects an out-of-scope leaderboard board (not one of the slots)', async () => {
    const kiosk = await seedKiosk();
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        {
          input: {
            kioskUuid: kiosk.uuid,
            layout: {
              version: 1,
              boards: [{ boardUuid: boardPub1.uuid }],
              leaderboard: { boardUuid: boardPub2.uuid, period: 'session' },
            },
          },
        },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
  });

  it('rejects a slot board that is not linked to this gym', async () => {
    const kiosk = await seedKiosk();
    // A board that lives in the OTHER gym must not be usable here.
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        {
          input: {
            kioskUuid: kiosk.uuid,
            layout: { version: 1, boards: [{ boardUuid: boardInPrivateGym.uuid }], leaderboard: null },
          },
        },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects a leaderboard board that is not linked to this gym', async () => {
    const kiosk = await seedKiosk();
    const stray = uuidv4();
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        {
          input: {
            kioskUuid: kiosk.uuid,
            layout: {
              version: 1,
              // `stray` is a slot (so it passes the in-slots refine) but isn't a
              // gym board, so the gym-link check must reject it.
              boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: stray }],
              leaderboard: { boardUuid: stray, period: 'week' },
            },
          },
        },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('persists a valid layout and resolves its boards', async () => {
    const kiosk = await seedKiosk();
    const updated = await socialGymKioskMutations.updateGymKiosk(
      null,
      {
        input: {
          kioskUuid: kiosk.uuid,
          layout: {
            version: 1,
            boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPub2.uuid }],
            leaderboard: { boardUuid: boardPub1.uuid, period: 'week' },
          },
        },
      },
      authCtx(OWNER),
    );
    expect(updated.boards.map((b) => b.boardUuid)).toEqual([boardPub1.uuid, boardPub2.uuid]);
    expect(updated.boards.every((b) => b.boardId != null)).toBe(true);
    // The install-QR needs each board's public slug. insertBoard seeds slug = uuid.
    expect(updated.boards.map((b) => b.slug)).toEqual([boardPub1.uuid, boardPub2.uuid]);
  });

  it('persists the schema-parsed layout, stripping unknown keys', async () => {
    const kiosk = await seedKiosk();
    await socialGymKioskMutations.updateGymKiosk(
      null,
      {
        input: {
          kioskUuid: kiosk.uuid,
          layout: {
            version: 1,
            boards: [{ boardUuid: boardPub1.uuid, extra: 'strip-me' }],
            leaderboard: null,
            foo: 'strip-me-too',
          },
        },
      },
      authCtx(OWNER),
    );

    const rows = await db.execute(sql`SELECT layout FROM gym_kiosks WHERE uuid = ${kiosk.uuid}`);
    const stored = Array.from(rows as Iterable<{ layout: Record<string, unknown> }>)[0].layout;
    expect(Object.keys(stored)).not.toContain('foo');
    const storedBoards = stored.boards as Array<Record<string, unknown>>;
    expect(Object.keys(storedBoards[0])).toEqual(['boardUuid']);
  });

  it('strips unknown keys at the leaderboard level too', async () => {
    const kiosk = await seedKiosk();
    await socialGymKioskMutations.updateGymKiosk(
      null,
      {
        input: {
          kioskUuid: kiosk.uuid,
          layout: {
            version: 1,
            boards: [{ boardUuid: boardPub1.uuid }],
            leaderboard: { boardUuid: boardPub1.uuid, period: 'week', junk: 'strip-me' },
          },
        },
      },
      authCtx(OWNER),
    );

    const rows = await db.execute(sql`SELECT layout FROM gym_kiosks WHERE uuid = ${kiosk.uuid}`);
    const stored = Array.from(rows as Iterable<{ layout: Record<string, unknown> }>)[0].layout;
    const storedLeaderboard = stored.leaderboard as Record<string, unknown>;
    expect(Object.keys(storedLeaderboard).sort()).toEqual(['boardUuid', 'period']);
    expect(storedLeaderboard.period).toBe('week');
  });

  it('surfaces an update-path duplicate slug as a clean error (not a 500)', async () => {
    await insertKiosk({ gymId: publicGym.id, slug: 'occupied', name: 'Occupied' });
    const kiosk = await seedKiosk();
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        null,
        { input: { kioskUuid: kiosk.uuid, slug: 'occupied' } },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'KIOSK_SLUG_ALREADY_EXISTS' } });
  });
});

// ============================================================================
// Public read: gymKiosk
// ============================================================================

describe('gymKiosk public read', () => {
  it('returns the oldest live kiosk when no kiosk slug is given', async () => {
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'old',
      name: 'Old',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await insertKiosk({ gymId: publicGym.id, slug: 'new', name: 'New', createdAt: new Date() });

    const kiosk = await socialGymKioskQueries.gymKiosk(null, { gymSlug: publicGym.slug }, anonCtx());
    expect(kiosk).not.toBeNull();
    expect(kiosk!.slug).toBe('old');
  });

  it('returns the named kiosk when a kiosk slug is given', async () => {
    await insertKiosk({ gymId: publicGym.id, slug: 'lobby', name: 'Lobby' });
    const kiosk = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'lobby' },
      anonCtx(),
    );
    expect(kiosk!.slug).toBe('lobby');
  });

  it('hides a private gym from anon + strangers but shows it to an editor', async () => {
    await insertKiosk({
      gymId: privateGym.id,
      slug: 'members',
      name: 'Members',
      layout: { version: 1, boards: [{ boardUuid: boardInPrivateGym.uuid }], leaderboard: null },
    });

    expect(await socialGymKioskQueries.gymKiosk(null, { gymSlug: privateGym.slug }, anonCtx())).toBeNull();
    expect(await socialGymKioskQueries.gymKiosk(null, { gymSlug: privateGym.slug }, authCtx(RANDOM))).toBeNull();

    const forOwner = await socialGymKioskQueries.gymKiosk(null, { gymSlug: privateGym.slug }, authCtx(OWNER));
    expect(forOwner).not.toBeNull();
    expect(forOwner!.boards.map((b) => b.boardUuid)).toEqual([boardInPrivateGym.uuid]);
  });

  it('filters non-public boards out of both `boards` and `layout` for anon', async () => {
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'mixed',
      name: 'Mixed',
      layout: {
        version: 1,
        boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPriv.uuid }],
        leaderboard: null,
      },
    });

    const kiosk = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'mixed' },
      anonCtx(),
    );
    // The private board is dropped from the resolved boards...
    expect(kiosk!.boards.map((b) => b.boardUuid)).toEqual([boardPub1.uuid]);
    // ...and the surviving public board exposes its slug for the install QR.
    expect(kiosk!.boards.map((b) => b.slug)).toEqual([boardPub1.uuid]);
    // The layout must not distribute a hidden board uuid to the public.
    expect(kiosk!.layout.boards.map((slot) => slot.boardUuid)).toEqual([boardPub1.uuid]);
  });

  it.each(['legacy booleans', 'current audience control'] as const)(
    'never exposes an Unlisted board capability in public kiosk JSON (%s)',
    async (shape) => {
      if (shape === 'legacy booleans') {
        await db
          .update(userBoards)
          .set({ isPublic: true, isUnlisted: true })
          .where(eq(userBoards.uuid, boardPriv.uuid));
      } else {
        await db.insert(resourcePrivacy).values({ kind: 'board', resourceId: boardPriv.uuid, audience: 'unlisted' });
      }
      await insertKiosk({
        gymId: publicGym.id,
        slug: 'unlisted-slot',
        name: 'Unlisted slot',
        layout: {
          version: 1,
          boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPriv.uuid }],
          leaderboard: { boardUuid: boardPriv.uuid, period: 'week' },
        },
      });
      for (const context of [anonCtx(), authCtx(RANDOM)]) {
        const kiosk = await socialGymKioskQueries.gymKiosk(
          null,
          { gymSlug: publicGym.slug, kioskSlug: 'unlisted-slot' },
          context,
        );
        expect(kiosk!.boards.map((board) => board.boardUuid)).toEqual([boardPub1.uuid]);
        expect(kiosk!.layout.boards.map((slot) => slot.boardUuid)).toEqual([boardPub1.uuid]);
        expect(kiosk!.layout.leaderboard).toBeNull();
        expect(JSON.stringify(kiosk)).not.toContain(boardPriv.uuid);
      }
      const editorKiosk = await socialGymKioskQueries.gymKiosk(
        null,
        { gymSlug: publicGym.slug, kioskSlug: 'unlisted-slot' },
        authCtx(EDITOR),
      );
      expect(editorKiosk!.layout.boards.map((slot) => slot.boardUuid)).toEqual([boardPub1.uuid, boardPriv.uuid]);
      expect(editorKiosk!.layout.leaderboard?.boardUuid).toBe(boardPriv.uuid);
    },
  );

  it('shows a private slot board (with boardId) to a gym EDITOR member', async () => {
    // Gym-level edit access drives slot visibility: an editor placing a private
    // board on a kiosk must see it in `boards` (not a placeholder), even though
    // the stricter per-board canEdit gate (used by UserBoard.boardId) says no.
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'editor-view',
      name: 'Editor View',
      layout: {
        version: 1,
        boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPriv.uuid }],
        leaderboard: null,
      },
    });

    const viaPublicRead = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'editor-view' },
      authCtx(EDITOR),
    );
    expect(viaPublicRead!.boards.map((b) => b.boardUuid)).toEqual([boardPub1.uuid, boardPriv.uuid]);
    const privateEntry = viaPublicRead!.boards.find((b) => b.boardUuid === boardPriv.uuid);
    expect(privateEntry!.boardId).toBe(boardPriv.id);

    // Same through the manage list.
    const manageList = await socialGymKioskQueries.gymKiosks(null, { gymUuid: publicGym.uuid }, authCtx(EDITOR));
    const managed = manageList.find((k) => k.slug === 'editor-view');
    expect(managed!.boards.map((b) => b.boardUuid)).toEqual([boardPub1.uuid, boardPriv.uuid]);
  });

  it('never lets gym edit authority open a linked board whose own policy denies the reader', async () => {
    // A stranger's Invite-only home board, linked to the public gym by its owner.
    const inviteOnly = await insertBoard({
      gymId: publicGym.id,
      ownerId: RANDOM,
      name: 'Stranger Invite Wall',
      isPublic: false,
    });
    await db.insert(resourcePrivacy).values({
      kind: 'board',
      resourceId: inviteOnly.uuid,
      ownerId: RANDOM,
      audience: 'invite_only',
    });
    // A Kilter community leader covers every public gym with a Kilter board.
    await db.execute(sql`
      INSERT INTO community_roles (user_id, role, board_type, created_at)
      VALUES (${LEADER}, 'community_leader', 'kilter', now())
    `);

    for (const reader of [ADMIN, EDITOR, LEADER]) {
      // The gym's own private board and the stranger's Invite-only board: id alone,
      // or id plus uuid, open neither (their policy has no link reading).
      for (const board of [boardPriv, inviteOnly]) {
        await expect(requireAnonReadableBoard(board.id, reader)).rejects.toThrow('Board not found');
        await expect(requireReadablePresenceBoard(board.id, reader)).rejects.toThrow('Board not found');
        await expect(requireReadablePresenceBoard(board.id, reader, board.uuid)).rejects.toThrow('Board not found');
      }
      const ctx = authCtx(reader);
      await expect(boardPresenceQueries.boardConnection(undefined, { boardId: inviteOnly.id }, ctx)).rejects.toThrow(
        'Board not found',
      );
      await expect(
        boardPresenceQueries.boardHistory(undefined, { boardId: inviteOnly.id, limit: 5 }, ctx),
      ).rejects.toThrow('Board not found');
      await expect(liveSessionQueries.boardLiveSessions(undefined, { boardId: inviteOnly.id }, ctx)).rejects.toThrow(
        'Board not found',
      );
      await expect(
        socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: inviteOnly.uuid } }, ctx),
      ).rejects.toThrow('Board not found');
      // The same reader cannot open the board itself, so presence matches it.
      expect(await socialBoardQueries.board(null, { boardUuid: inviteOnly.uuid }, ctx)).toBeNull();
      // A Public gym board stays readable by its id alone.
      await expect(requireReadablePresenceBoard(boardPub1.id, reader)).resolves.toMatchObject({
        anonReadableVerified: false,
      });
    }

    // Owners keep their own boards by the id alone.
    await expect(requireReadablePresenceBoard(boardPriv.id, OWNER)).resolves.toMatchObject({
      anonReadableVerified: false,
    });
    await expect(requireAnonReadableBoard(inviteOnly.id, RANDOM)).resolves.toBeUndefined();
    // An approved grant is what opens it, gym role or not.
    await db.execute(sql`
      INSERT INTO resource_grants (kind, resource_id, user_id, status, invited_by)
      VALUES ('board', ${inviteOnly.uuid}, ${EDITOR}, 'approved', ${RANDOM})
    `);
    await expect(requireAnonReadableBoard(inviteOnly.id, EDITOR)).resolves.toBeUndefined();
  });

  it('opens an Unlisted gym board another owner holds to an editor only when the caller presents its uuid', async () => {
    const unlisted = await insertBoard({
      gymId: publicGym.id,
      ownerId: RANDOM,
      name: 'Stranger Unlisted Wall',
      isPublic: false,
    });
    await db.insert(resourcePrivacy).values({
      kind: 'board',
      resourceId: unlisted.uuid,
      ownerId: RANDOM,
      audience: 'unlisted',
    });
    await expect(requireReadablePresenceBoard(unlisted.id, EDITOR)).rejects.toThrow('Board not found');
    await expect(requireReadablePresenceBoard(unlisted.id, EDITOR, unlisted.uuid)).resolves.toMatchObject({
      anonReadableVerified: false,
    });
  });

  it('never trusts a kiosk slot or unrelated gym edit role to open a foreign home board', async () => {
    const foreign = await insertBoard({
      gymId: privateGym.id,
      ownerId: RANDOM,
      name: 'Foreign Private Wall',
      isPublic: false,
    });
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'forged-foreign',
      name: 'Forged',
      layout: { version: 1, boards: [{ boardUuid: foreign.uuid }], leaderboard: null },
    });
    const kiosk = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'forged-foreign' },
      authCtx(EDITOR),
    );
    expect(kiosk!.boards).toEqual([]);
    await expect(requireReadablePresenceBoard(foreign.id, EDITOR, foreign.uuid)).rejects.toThrow('Board not found');
    await db.update(userBoards).set({ gymId: null }).where(eq(userBoards.id, foreign.id));
    await expect(requireAnonReadableBoard(foreign.id, EDITOR, foreign.uuid)).rejects.toThrow('Board not found');
    await db.execute(sql`UPDATE gyms SET deleted_at = now() WHERE id = ${publicGym.id}`);
    await expect(requireReadablePresenceBoard(boardPriv.id, EDITOR)).rejects.toThrow('Board not found');
  });

  it('still filters the private slot board for a signed-in NON-editor', async () => {
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'rando-view',
      name: 'Rando View',
      layout: {
        version: 1,
        boards: [{ boardUuid: boardPub1.uuid }, { boardUuid: boardPriv.uuid }],
        leaderboard: null,
      },
    });
    const kiosk = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'rando-view' },
      authCtx(RANDOM),
    );
    expect(kiosk!.boards.map((b) => b.boardUuid)).toEqual([boardPub1.uuid]);
  });

  it('omits a dead board and its slot from the public layout', async () => {
    const boardPub3 = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'D Wall', isPublic: true });
    const boardPub4 = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'E Wall', isPublic: true });
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'quad',
      name: 'Quad',
      layout: {
        version: 1,
        boards: [
          { boardUuid: boardPub1.uuid },
          { boardUuid: boardPub2.uuid },
          { boardUuid: boardPub3.uuid },
          { boardUuid: boardPub4.uuid },
        ],
        leaderboard: null,
      },
    });
    // Soft-delete one of the four boards.
    await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE uuid = ${boardPub4.uuid}`);

    const kiosk = await socialGymKioskQueries.gymKiosk(null, { gymSlug: publicGym.slug, kioskSlug: 'quad' }, anonCtx());
    expect(kiosk!.boards).toHaveLength(3);
    expect(kiosk!.layout.boards).toHaveLength(3);
  });

  it('reads a corrupted stored layout leniently as an empty layout', async () => {
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'corrupt',
      name: 'Corrupt',
      // Unrecognised version — the lenient reader returns an empty layout.
      layout: { version: 99, boards: [{ nope: true }], leaderboard: { bad: 1 } },
    });

    const kiosk = await socialGymKioskQueries.gymKiosk(
      null,
      { gymSlug: publicGym.slug, kioskSlug: 'corrupt' },
      anonCtx(),
    );
    expect(kiosk).not.toBeNull();
    expect(kiosk!.layout.version).toBe(1);
    expect(kiosk!.layout.boards).toEqual([]);
    expect(kiosk!.boards).toEqual([]);
  });

  it('returns null for an unknown gym slug', async () => {
    expect(await socialGymKioskQueries.gymKiosk(null, { gymSlug: 'no-such-gym' }, anonCtx())).toBeNull();
  });

  it('returns null when the gym has no kiosks', async () => {
    expect(await socialGymKioskQueries.gymKiosk(null, { gymSlug: publicGym.slug }, anonCtx())).toBeNull();
  });
});

// ============================================================================
// Manage list: gymKiosks
// ============================================================================

describe('gymKiosks manage list', () => {
  beforeEach(async () => {
    await insertKiosk({
      gymId: publicGym.id,
      slug: 'first',
      name: 'First',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await insertKiosk({ gymId: publicGym.id, slug: 'second', name: 'Second', createdAt: new Date() });
  });

  it('lists a gym editor its kiosks, oldest first', async () => {
    for (const viewer of [OWNER, ADMIN, EDITOR]) {
      const kiosks = await socialGymKioskQueries.gymKiosks(null, { gymUuid: publicGym.uuid }, authCtx(viewer));
      expect(kiosks.map((k) => k.slug)).toEqual(['first', 'second']);
    }
  });

  it('rejects the manage list for a plain member, a stranger, and anon', async () => {
    for (const viewer of [MEMBER, RANDOM]) {
      await expect(
        socialGymKioskQueries.gymKiosks(null, { gymUuid: publicGym.uuid }, authCtx(viewer)),
      ).rejects.toThrow();
    }
    await expect(socialGymKioskQueries.gymKiosks(null, { gymUuid: publicGym.uuid }, anonCtx())).rejects.toThrow();
  });
});
