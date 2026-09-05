import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql, eq, is, SQL } from 'drizzle-orm';
import type { GraphQLError } from 'graphql';
import { GYM_HOURS_MAX_LENGTH, type ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { socialGymQueries, socialGymMutations, mapRawGymRow, enrichGym } from '../graphql/resolvers/social/gyms';
import {
  socialGymClaimMutations,
  socialGymClaimQueries,
  gymClaimFieldResolvers,
  applyGymClaim,
  verifyGymClaimByToken,
  hashClaimToken,
  MAX_PENDING_CLAIMS_PER_USER,
  GYM_CLAIM_LIMIT_CODE,
  GYM_CLAIM_SUPERSEDED_CODE,
} from '../graphql/resolvers/social/gym-claims';
import { socialGymOwnerReassignMutations } from '../graphql/resolvers/social/gym-owner-reassign';
import {
  socialCommunitySettingsMutations,
  socialCommunitySettingsQueries,
} from '../graphql/resolvers/social/community-settings';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for the gym write-access (editor) role + grant/revoke
 * mutations, and the gym ownership claim flow (domain-verified + admin-review).
 *
 * Mirrors board-gym-edit-authorization.test.ts: seeds via raw SQL, calls the
 * resolvers directly against the per-worker test DB. The email module is mocked
 * so no SMTP is attempted and we can assert the senders fire; hashClaimToken is
 * the real implementation (it lives in gym-claims.ts, not the email module).
 */

// Mock the email senders (path relative to THIS test file). The claim resolver
// imports the same module via '../../../email/email-service', which resolves to
// the same absolute path, so these mocks intercept it. vi.mock is hoisted, so
// the `import` below binds to the mocked functions.
vi.mock('../email/email-service', () => ({
  sendGymClaimVerificationEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimAdminNotification: vi.fn(() => Promise.resolve()),
  sendGymClaimApprovedEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimDeniedEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimOwnershipLostEmail: vi.fn(() => Promise.resolve()),
}));
import {
  sendGymClaimVerificationEmail,
  sendGymClaimAdminNotification,
  sendGymClaimApprovedEmail,
  sendGymClaimDeniedEmail,
  sendGymClaimOwnershipLostEmail,
} from '../email/email-service';

// The system/import owner — a real prior owner is kept on as a gym admin after a
// claim, but the system owner is not (it's a catalog placeholder, not a person).
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';

const OWNER = 'gw-owner';
const GLOBAL_ADMIN = 'gw-global-admin';
const KILTER_LEADER = 'gw-kilter-leader';
const MOON_LEADER = 'gw-moon-leader';
const PLAIN_USER = 'gw-plain-user';
const GYM_ADMIN_MEMBER = 'gw-gym-admin';
const EDITOR_TARGET = 'gw-editor-target';
const SECOND_TARGET = 'gw-second-target';
const CLAIMANT = 'gw-claimant';
const PRIOR_OWNER = 'gw-prior-owner';

const ALL_USERS = [
  OWNER,
  GLOBAL_ADMIN,
  KILTER_LEADER,
  MOON_LEADER,
  PLAIN_USER,
  GYM_ADMIN_MEMBER,
  EDITOR_TARGET,
  SECOND_TARGET,
  CLAIMANT,
  PRIOR_OWNER,
];

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertRole = (userId: string, role: string, boardType: string | null) =>
  db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${userId}, ${role}, ${boardType}, now())
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  uuid?: string;
  website?: string | null;
  isPublic?: boolean;
  websiteVouchedByOwner?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, uuid = uuidv4(), website = null, isPublic = true } = opts;
  // Default to the same rule the 0192 backfill encodes: a seeded website counts
  // as owner-vouched only on a user-owned gym. A SYSTEM-owned gym can never be
  // vouched in production (its owner is the never-logged-in import user), so the
  // helper must not seed that fiction. Pass the flag explicitly to force a value.
  const websiteVouchedByOwner = opts.websiteVouchedByOwner ?? (website != null && ownerId !== SYSTEM_OWNER);
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, website, website_vouched_by_owner, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${website}, ${websiteVouchedByOwner}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertBoard = async (gymId: number, ownerId: string, boardType = 'kilter'): Promise<number> => {
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, ${boardType}, 1, 10, '1,2', 'Wall', ${gymId}, true, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

const insertClaim = async (opts: {
  gymId: number;
  claimantUserId: string;
  method: string;
  status?: string;
  claimEmail?: string | null;
  tokenHash?: string | null;
  expiresAt?: Date | null;
}): Promise<number> => {
  const {
    gymId,
    claimantUserId,
    method,
    status = 'pending',
    claimEmail = null,
    tokenHash = null,
    expiresAt = null,
  } = opts;
  // Bind expires_at as an ISO string, not a Date — a raw `db.execute(sql...)`
  // param bypasses Drizzle column typing, and the postgres-js driver rejects a
  // Date instance for a raw timestamp parameter.
  const result = await db.execute(sql`
    INSERT INTO gym_claims (gym_id, claimant_user_id, method, status, claim_email, token_hash, expires_at, created_at, updated_at)
    VALUES (${gymId}, ${claimantUserId}, ${method}, ${status}, ${claimEmail}, ${tokenHash}, ${expiresAt ? expiresAt.toISOString() : null}, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

const gymMemberRole = async (gymId: number, userId: string): Promise<string | null> => {
  const result = await db.execute(sql`
    SELECT role FROM gym_members WHERE gym_id = ${gymId} AND user_id = ${userId} LIMIT 1
  `);
  const row = Array.from(result as Iterable<{ role: string }>)[0];
  return row ? row.role : null;
};

// Whether the gym's current website is trusted for the self-service domain claim
// (#3431). Read straight from the column so a test names the state transition,
// not just its downstream effect.
const gymWebsiteVouched = async (gymId: number): Promise<boolean> => {
  const result = await db.execute(sql`SELECT website_vouched_by_owner FROM gyms WHERE id = ${gymId} LIMIT 1`);
  return Array.from(result as Iterable<{ website_vouched_by_owner: boolean }>)[0].website_vouched_by_owner;
};

const gymWebsite = async (gymId: number): Promise<string | null> => {
  const result = await db.execute(sql`SELECT website FROM gyms WHERE id = ${gymId} LIMIT 1`);
  return Array.from(result as Iterable<{ website: string | null }>)[0].website;
};

const claimRowCount = async (gymId: number): Promise<number> => {
  const [countRow] = Array.from(
    (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${gymId}`)) as Iterable<{
      c: number;
    }>,
  );
  return Number(countRow.c);
};

/**
 * Run `body()` with `db.update(gyms)` intercepted, for the two things a #3431
 * TOCTOU test needs and cannot get any other way:
 *
 * 1. It records the SET payload the resolver hands Drizzle, so an assertion can
 *    read the predicate the resolver ACTUALLY built rather than a rebuilt copy
 *    (a rebuilt predicate asserts nothing).
 * 2. `interleave` runs after the resolver has read its gym snapshot and before
 *    its UPDATE reaches Postgres — the exact window a concurrent owner write
 *    lands in. That makes the race deterministic instead of unpinnable.
 *
 * The stand-in only implements the exact `.set().where().returning()` chain
 * updateGym uses, then delegates to the real builder. If that chain ever
 * changes, this throws rather than quietly skipping the interleave.
 */
const withInterceptedGymUpdate = async <T>(
  body: () => Promise<T>,
  interleave?: () => Promise<void>,
): Promise<{ result: T; setPayloads: Record<string, unknown>[] }> => {
  const setPayloads: Record<string, unknown>[] = [];
  const realUpdate = db.update.bind(db);
  const spy = vi.spyOn(db, 'update') as unknown as {
    mockImplementation: (fn: (table: unknown) => unknown) => void;
    mockRestore: () => void;
  };

  spy.mockImplementation((table: unknown) => {
    if (table !== dbSchema.gyms) return realUpdate(table as typeof dbSchema.gyms);
    let captured: Record<string, unknown> = {};
    let condition: SQL | undefined;
    const standIn = {
      set(values: Record<string, unknown>) {
        captured = values;
        setPayloads.push(values);
        return standIn;
      },
      where(cond: SQL | undefined) {
        condition = cond;
        return standIn;
      },
      async returning() {
        if (interleave) await interleave();
        return realUpdate(dbSchema.gyms).set(captured).where(condition).returning();
      },
    };
    return standIn;
  });

  try {
    const result = await body();
    return { result, setPayloads };
  } finally {
    spy.mockRestore();
  }
};

const gymOwnerId = async (gymUuid: string): Promise<string> => {
  const result = await db.execute(sql`SELECT owner_id FROM gyms WHERE uuid = ${gymUuid} LIMIT 1`);
  return Array.from(result as Iterable<{ owner_id: string }>)[0].owner_id;
};

const claimStatus = async (claimId: number): Promise<string> => {
  const result = await db.execute(sql`SELECT status FROM gym_claims WHERE id = ${claimId} LIMIT 1`);
  return Array.from(result as Iterable<{ status: string }>)[0].status;
};

// The gym_claim_approved notifications a user received, newest first.
const claimApprovedNotifications = async (
  recipientId: string,
): Promise<Array<{ entity_type: string | null; entity_id: string | null; actor_id: string | null }>> => {
  const result = await db.execute(sql`
    SELECT entity_type, entity_id, actor_id
    FROM notifications
    WHERE recipient_id = ${recipientId} AND type = 'gym_claim_approved'
    ORDER BY created_at DESC
  `);
  return Array.from(
    result as Iterable<{ entity_type: string | null; entity_id: string | null; actor_id: string | null }>,
  );
};

const canEditGym = async (gymUuid: string, ctx: ConnectionContext): Promise<boolean> => {
  const gym = await socialGymQueries.gym(null, { gymUuid }, ctx);
  expect(gym).not.toBeNull();
  return gym!.canEdit;
};

// Shared kilter gym (owned by OWNER, one kilter board so a kilter community
// leader covers it) for the write-access suite.
let gymId: number;
let gymUuid: string;

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "community_settings", "gym_members", "gym_follows", "gym_claims",
      "gym_owner_reassignments", "board_follows", "boardsesh_ticks", "user_boards", "gyms",
      "notifications"
    RESTART IDENTITY CASCADE
  `);

  // Clear mock call history so per-test email assertions start fresh (keeps the
  // Promise.resolve() implementations).
  vi.clearAllMocks();

  await Promise.all(ALL_USERS.map(insertUser));

  await Promise.all([
    insertRole(GLOBAL_ADMIN, 'admin', null),
    insertRole(KILTER_LEADER, 'community_leader', 'kilter'),
    insertRole(MOON_LEADER, 'community_leader', 'moonboard'),
  ]);

  const gym = await insertGym({ ownerId: OWNER, name: 'Bonsist' });
  gymId = gym.id;
  gymUuid = gym.uuid;
  await insertBoard(gymId, OWNER, 'kilter');
  await insertGymMember(gymId, GYM_ADMIN_MEMBER, 'admin');
});

// ============================================================================
// Write access / roles
// ============================================================================

describe('grantGymWriteAccess authorization', () => {
  it('lets a covering community_leader grant editor access to an arbitrary user', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(
        null,
        { input: { gymUuid, userId: EDITOR_TARGET } },
        authCtx(KILTER_LEADER),
      ),
    ).resolves.toBe(true);

    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('editor');
  });

  it('lets a global community admin grant editor access to an arbitrary user', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(
        null,
        { input: { gymUuid, userId: SECOND_TARGET } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).resolves.toBe(true);

    expect(await gymMemberRole(gymId, SECOND_TARGET)).toBe('editor');
  });

  it('lets the gym owner grant editor access', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER)),
    ).resolves.toBe(true);
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('editor');
  });

  it('rejects a plain logged-in user (no role, not owner/admin) from granting', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(PLAIN_USER)),
    ).rejects.toThrow(/Not authorized to grant write access/);
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBeNull();
  });

  it('rejects a community_leader scoped to the WRONG board type', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(MOON_LEADER)),
    ).rejects.toThrow(/Not authorized to grant write access/);
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBeNull();
  });

  it('does NOT downgrade an existing gym admin member to editor', async () => {
    // GYM_ADMIN_MEMBER already holds 'admin'. A grant must not clobber that.
    await expect(
      socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: GYM_ADMIN_MEMBER } }, authCtx(OWNER)),
    ).resolves.toBe(true);
    expect(await gymMemberRole(gymId, GYM_ADMIN_MEMBER)).toBe('admin');
  });
});

describe('an editor can edit the gym but cannot manage/grant/delete', () => {
  beforeEach(async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
  });

  it('reports canEdit=true via the gym query and can updateGym', async () => {
    expect(await canEditGym(gymUuid, authCtx(EDITOR_TARGET))).toBe(true);

    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid, description: 'Editor fixed the hours' } },
      authCtx(EDITOR_TARGET),
    );
    expect(result.description).toBe('Editor fixed the hours');
  });

  it('cannot deleteGym (owner-only)', async () => {
    await expect(socialGymMutations.deleteGym(null, { gymUuid }, authCtx(EDITOR_TARGET))).rejects.toThrow(
      /Not authorized to delete this gym/,
    );
  });

  it('cannot add or remove gym members (owner/admin-only)', async () => {
    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid, userId: PLAIN_USER, role: 'member' } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/must be gym owner or admin/);

    await expect(
      socialGymMutations.removeGymMember(
        null,
        { input: { gymUuid, userId: GYM_ADMIN_MEMBER } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/must be gym owner or admin/);
  });

  it('cannot grant write access to someone else (editors are not grantors)', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(
        null,
        { input: { gymUuid, userId: SECOND_TARGET } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/Not authorized to grant write access/);
    expect(await gymMemberRole(gymId, SECOND_TARGET)).toBeNull();
  });
});

describe('revokeGymWriteAccess', () => {
  it('removes an editor row', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('editor');

    await expect(
      socialGymMutations.revokeGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER)),
    ).resolves.toBe(true);
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBeNull();
  });

  it('is a no-op on a gym admin member (never demotes/removes an admin)', async () => {
    await expect(
      socialGymMutations.revokeGymWriteAccess(null, { input: { gymUuid, userId: GYM_ADMIN_MEMBER } }, authCtx(OWNER)),
    ).resolves.toBe(true);
    expect(await gymMemberRole(gymId, GYM_ADMIN_MEMBER)).toBe('admin');
  });

  it('rejects callers who are not owner/gym-admin/covering-community — same gate as grant', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));

    // A plain user can't revoke.
    await expect(
      socialGymMutations.revokeGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(PLAIN_USER)),
    ).rejects.toThrow(/Not authorized to grant write access/);
    // An editor can't revoke (editors are not grantors — access can't unspread itself).
    await expect(
      socialGymMutations.revokeGymWriteAccess(
        null,
        { input: { gymUuid, userId: EDITOR_TARGET } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/Not authorized to grant write access/);
    // A community leader scoped to the WRONG board type can't revoke.
    await expect(
      socialGymMutations.revokeGymWriteAccess(
        null,
        { input: { gymUuid, userId: EDITOR_TARGET } },
        authCtx(MOON_LEADER),
      ),
    ).rejects.toThrow(/Not authorized to grant write access/);

    // The editor row survived every rejected attempt.
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('editor');
  });
});

describe('enrichGym canGrantAccess and canClaim', () => {
  const gymFor = async (ctx: ConnectionContext) => {
    const gym = await socialGymQueries.gym(null, { gymUuid }, ctx);
    expect(gym).not.toBeNull();
    return gym!;
  };

  it('canGrantAccess is true for owner, gym admin, covering leader, and global admin', async () => {
    expect((await gymFor(authCtx(OWNER))).canGrantAccess).toBe(true);
    expect((await gymFor(authCtx(GYM_ADMIN_MEMBER))).canGrantAccess).toBe(true);
    expect((await gymFor(authCtx(KILTER_LEADER))).canGrantAccess).toBe(true);
    expect((await gymFor(authCtx(GLOBAL_ADMIN))).canGrantAccess).toBe(true);
  });

  it('canGrantAccess is false for a plain editor and for an anonymous viewer', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
    expect((await gymFor(authCtx(EDITOR_TARGET))).canGrantAccess).toBe(false);
    // ...but the editor can still edit.
    expect((await gymFor(authCtx(EDITOR_TARGET))).canEdit).toBe(true);
    expect((await gymFor(anonCtx())).canGrantAccess).toBe(false);
  });

  it('canClaim is true for a non-owner with no edit access, false for anyone who can already edit', async () => {
    expect((await gymFor(authCtx(PLAIN_USER))).canClaim).toBe(true);
    expect((await gymFor(authCtx(OWNER))).canClaim).toBe(false);
    // Anonymous viewers can't claim either.
    expect((await gymFor(anonCtx())).canClaim).toBe(false);
    // Anyone who can already edit the gym is excluded (they'd hit the domain-path
    // block and shouldn't see a Claim button).
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
    expect((await gymFor(authCtx(EDITOR_TARGET))).canClaim).toBe(false);
    expect((await gymFor(authCtx(GYM_ADMIN_MEMBER))).canClaim).toBe(false);
    expect((await gymFor(authCtx(KILTER_LEADER))).canClaim).toBe(false);
  });

  it('canClaim stays true for a plain member (social membership, no edit access)', async () => {
    // A plain `member` row is social-only — no edit access — so they can still
    // start a claim, unlike an editor/admin.
    await insertGymMember(gymId, PLAIN_USER, 'member');
    const gym = await gymFor(authCtx(PLAIN_USER));
    expect(gym.canClaim).toBe(true);
    expect(gym.canEdit).toBe(false);
  });
});

describe('grant notifies the new staff member', () => {
  it('grantGymWriteAccess creates a "you now manage this gym" notification for the new editor', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));

    // Same shape as a claim approval: gym-typed, deep-links by gym UUID, no actor.
    const notifications = await claimApprovedNotifications(EDITOR_TARGET);
    expect(notifications).toEqual([{ entity_type: 'gym', entity_id: gymUuid, actor_id: null }]);
  });

  it('does NOT notify when the grant is a no-op re-grant of an existing gym admin', async () => {
    // GYM_ADMIN_MEMBER is already admin — the setWhere skips the update, so no
    // row is returned and no redundant "you now manage" ping fires.
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid, userId: GYM_ADMIN_MEMBER } },
      authCtx(OWNER),
    );
    expect(await claimApprovedNotifications(GYM_ADMIN_MEMBER)).toEqual([]);
  });

  it('does NOT re-notify when re-granting an existing editor (only the first grant pings)', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
    // Second grant on the same editor is a no-op — the setWhere only promotes a
    // plain member, so RETURNING is empty and no second notification fires.
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));

    expect(await claimApprovedNotifications(EDITOR_TARGET)).toEqual([
      { entity_type: 'gym', entity_id: gymUuid, actor_id: null },
    ]);
    // The editor row survived the no-op re-grant.
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('editor');
  });

  it('notifies when a plain member is promoted to editor', async () => {
    await insertGymMember(gymId, PLAIN_USER, 'member');
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: PLAIN_USER } }, authCtx(OWNER));

    expect(await gymMemberRole(gymId, PLAIN_USER)).toBe('editor');
    expect(await claimApprovedNotifications(PLAIN_USER)).toEqual([
      { entity_type: 'gym', entity_id: gymUuid, actor_id: null },
    ]);
  });

  it('addGymMember notifies a fresh admin but not a plain member', async () => {
    await socialGymMutations.addGymMember(
      null,
      { input: { gymUuid, userId: EDITOR_TARGET, role: 'admin' } },
      authCtx(OWNER),
    );
    expect(await claimApprovedNotifications(EDITOR_TARGET)).toEqual([
      { entity_type: 'gym', entity_id: gymUuid, actor_id: null },
    ]);

    // A plain member is social-only (no manage access) — no notification.
    await socialGymMutations.addGymMember(
      null,
      { input: { gymUuid, userId: SECOND_TARGET, role: 'member' } },
      authCtx(OWNER),
    );
    expect(await claimApprovedNotifications(SECOND_TARGET)).toEqual([]);
  });
});

describe('myGyms includes owned + membership', () => {
  const myGymRoleFor = async (ctx: ConnectionContext, uuid: string): Promise<string | null | undefined> => {
    const result = await socialGymQueries.myGyms(null, { input: {} }, ctx);
    const match = result.gyms.find((g) => g.uuid === uuid);
    return match ? match.myRole : null;
  };

  it('the owner sees their owned gym with myRole=admin', async () => {
    expect(await myGymRoleFor(authCtx(OWNER), gymUuid)).toBe('admin');
  });

  it('a gym admin member sees the gym they administer with myRole=admin', async () => {
    // GYM_ADMIN_MEMBER holds an admin row on the shared gym but does not own it.
    const result = await socialGymQueries.myGyms(null, { input: {} }, authCtx(GYM_ADMIN_MEMBER));
    expect(result.gyms.map((g) => g.uuid)).toContain(gymUuid);
    expect(await myGymRoleFor(authCtx(GYM_ADMIN_MEMBER), gymUuid)).toBe('admin');
  });

  it('an editor sees the gym they were granted on with myRole=editor', async () => {
    await socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: EDITOR_TARGET } }, authCtx(OWNER));
    expect(await myGymRoleFor(authCtx(EDITOR_TARGET), gymUuid)).toBe('editor');
  });

  it('a plain member sees the gym with myRole=member', async () => {
    await insertGymMember(gymId, PLAIN_USER, 'member');
    expect(await myGymRoleFor(authCtx(PLAIN_USER), gymUuid)).toBe('member');
  });

  it('a user with no owner/member relationship does not see the gym', async () => {
    const result = await socialGymQueries.myGyms(null, { input: {} }, authCtx(EDITOR_TARGET));
    expect(result.gyms.map((g) => g.uuid)).not.toContain(gymUuid);
    expect(result.totalCount).toBe(0);
  });

  it('does not duplicate a gym when the viewer is both owner and (impossibly) a member row', async () => {
    // Contrived: plant a member row for the owner on their own gym. The OR over a
    // single gyms table still resolves to one row — no dupe, counted once.
    await insertGymMember(gymId, OWNER, 'member');
    const result = await socialGymQueries.myGyms(null, { input: {} }, authCtx(OWNER));
    expect(result.gyms.filter((g) => g.uuid === gymUuid)).toHaveLength(1);
    expect(result.totalCount).toBe(1);
  });

  it('paginates and counts a mixed owned + member result set correctly', async () => {
    // PLAIN_USER owns two gyms and is a member of the shared gym → three total,
    // spanning both the owner and the member branch of the OR.
    const owned1 = await insertGym({ ownerId: PLAIN_USER, name: 'PU Owned 1' });
    const owned2 = await insertGym({ ownerId: PLAIN_USER, name: 'PU Owned 2' });
    await insertGymMember(gymId, PLAIN_USER, 'editor');
    const expectedUuids = new Set([owned1.uuid, owned2.uuid, gymUuid]);

    const page1 = await socialGymQueries.myGyms(null, { input: { limit: 2, offset: 0 } }, authCtx(PLAIN_USER));
    expect(page1.totalCount).toBe(3);
    expect(page1.gyms).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await socialGymQueries.myGyms(null, { input: { limit: 2, offset: 2 } }, authCtx(PLAIN_USER));
    expect(page2.totalCount).toBe(3);
    expect(page2.gyms).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    // The two pages together cover all three gyms exactly once — count and
    // cursor stay consistent across the owned/member union.
    const seen = [...page1.gyms, ...page2.gyms].map((g) => g.uuid);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(expectedUuids);
  });
});

describe('addGymMember role restriction', () => {
  it('rejects the editor role — write access must go through grantGymWriteAccess', async () => {
    // `editor` is not addable via member management; it's planted only by the
    // grant path (owner/admin/community-leader gate).
    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid, userId: EDITOR_TARGET, role: 'editor' } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBeNull();

    // admin and member still add fine.
    await socialGymMutations.addGymMember(
      null,
      { input: { gymUuid, userId: EDITOR_TARGET, role: 'member' } },
      authCtx(OWNER),
    );
    expect(await gymMemberRole(gymId, EDITOR_TARGET)).toBe('member');
  });
});

describe('website field round-trips', () => {
  it('createGym stores website and enrichGym reads it back', async () => {
    const created = await socialGymMutations.createGym(
      null,
      { input: { name: 'New Wall Gym', website: 'https://www.example-gym.com' } },
      authCtx(PLAIN_USER),
    );
    expect(created.website).toBe('https://www.example-gym.com');

    const readBack = await socialGymQueries.gym(null, { gymUuid: created.uuid }, authCtx(PLAIN_USER));
    expect(readBack?.website).toBe('https://www.example-gym.com');
  });

  it('updateGym updates website and enrichGym reads it back', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid, website: 'https://www.bonsist.bg' } },
      authCtx(OWNER),
    );
    expect(result.website).toBe('https://www.bonsist.bg');

    const readBack = await socialGymQueries.gym(null, { gymUuid }, authCtx(OWNER));
    expect(readBack?.website).toBe('https://www.bonsist.bg');
  });
});

describe('gym hours', () => {
  // Read the two columns straight from the row so a test names the stored state
  // rather than only its rendered form.
  const storedHours = async (id: number): Promise<{ hours: string | null; hours_updated_at: string | Date | null }> => {
    const result = await db.execute(sql`SELECT hours, hours_updated_at FROM gyms WHERE id = ${id} LIMIT 1`);
    return Array.from(result as Iterable<{ hours: string | null; hours_updated_at: string | Date | null }>)[0];
  };

  const seedHours = (id: number, hours: string, confirmedAt: string) =>
    db.execute(sql`UPDATE gyms SET hours = ${hours}, hours_updated_at = ${confirmedAt} WHERE id = ${id}`);

  const A_YEAR_AGO = '2025-01-02T09:00:00.000Z';

  it('stamps the confirmation date when the hours are written', async () => {
    const before = Date.now();

    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid, hours: 'Mon-Fri 7-22, Sat-Sun 9-20' } },
      authCtx(OWNER),
    );

    expect(result.hours).toBe('Mon-Fri 7-22, Sat-Sun 9-20');
    // The stamp is a String field on the GraphQL type; the public page parses it
    // as an ISO timestamp, so it must not come back as a Date or a PG string.
    expect(typeof result.hoursUpdatedAt).toBe('string');
    expect(new Date(result.hoursUpdatedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('re-dates a stale stamp when the owner confirms the same hours again', async () => {
    await seedHours(gymId, 'Mon-Fri 7-22', A_YEAR_AGO);

    await socialGymMutations.updateGym(null, { input: { gymUuid, hours: 'Mon-Fri 7-22' } }, authCtx(OWNER));

    const row = await storedHours(gymId);
    expect(row.hours).toBe('Mon-Fri 7-22');
    expect(new Date(row.hours_updated_at!).getTime()).toBeGreaterThan(new Date(A_YEAR_AGO).getTime());
  });

  it('leaves both columns untouched when the input omits hours', async () => {
    await seedHours(gymId, 'Mon-Fri 7-22', A_YEAR_AGO);
    const seeded = await storedHours(gymId);

    // A save from a form that never showed the field must not silently
    // re-confirm a schedule nobody looked at.
    await socialGymMutations.updateGym(null, { input: { gymUuid, name: 'Bonsist Centre' } }, authCtx(OWNER));

    const row = await storedHours(gymId);
    expect(row.hours).toBe('Mon-Fri 7-22');
    // Compare the read-back value against the same value read the same way, not
    // against a UTC literal: hours_updated_at is `timestamp` WITHOUT time zone,
    // so the driver hands back a Date built in the host's zone and a literal
    // comparison would only hold on a UTC machine.
    expect(new Date(row.hours_updated_at!).getTime()).toBe(new Date(seeded.hours_updated_at!).getTime());
  });

  it('clears the stamp along with the hours when null is sent', async () => {
    await seedHours(gymId, 'Mon-Fri 7-22', A_YEAR_AGO);

    const result = await socialGymMutations.updateGym(null, { input: { gymUuid, hours: null } }, authCtx(OWNER));

    expect(result.hours).toBeNull();
    expect(result.hoursUpdatedAt).toBeNull();
    const row = await storedHours(gymId);
    expect(row.hours).toBeNull();
    expect(row.hours_updated_at).toBeNull();
  });

  it('treats a whitespace-only value as a clear, not as hours with a fresh stamp', async () => {
    await seedHours(gymId, 'Mon-Fri 7-22', A_YEAR_AGO);

    // The web form can't send this; the GraphQL API can. Storing "   " plus a
    // new confirmation date would leave a stamp vouching for hours the page
    // renders as absent.
    const result = await socialGymMutations.updateGym(null, { input: { gymUuid, hours: '   ' } }, authCtx(OWNER));

    expect(result.hours).toBeNull();
    expect(result.hoursUpdatedAt).toBeNull();
    const row = await storedHours(gymId);
    expect(row.hours).toBeNull();
    expect(row.hours_updated_at).toBeNull();
  });

  it('stores hours trimmed', async () => {
    const result = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid, hours: '  Mon-Fri 7-22  ' } },
      authCtx(OWNER),
    );
    expect(result.hours).toBe('Mon-Fri 7-22');
  });

  it('rejects hours longer than the cap', async () => {
    await expect(
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid, hours: 'x'.repeat(GYM_HOURS_MAX_LENGTH + 1) } },
        authCtx(OWNER),
      ),
    ).rejects.toThrow();

    expect((await storedHours(gymId)).hours).toBeNull();
  });

  it('accepts hours exactly at the cap', async () => {
    const atCap = 'x'.repeat(GYM_HOURS_MAX_LENGTH);
    const result = await socialGymMutations.updateGym(null, { input: { gymUuid, hours: atCap } }, authCtx(OWNER));
    expect(result.hours).toBe(atCap);
  });

  it('maps hours off a raw snake_case row, the way the proximity search path does', async () => {
    await seedHours(gymId, 'Mon-Fri 7-22', A_YEAR_AGO);

    // The PostGIS proximity branch of searchGyms is a raw `SELECT *`, so it hands
    // mapRawGymRow snake_case keys. A camelCase read there type-checks and then
    // returns null forever while the Drizzle path looks healthy — this is the guard.
    const rawResult = await db.execute(sql`SELECT * FROM gyms WHERE id = ${gymId}`);
    const rawRow = Array.from(rawResult as Iterable<Record<string, unknown>>)[0];
    expect(Object.keys(rawRow)).toContain('hours_updated_at');

    const mapped = mapRawGymRow(rawRow);
    expect(mapped.hours).toBe('Mon-Fri 7-22');
    expect(mapped.hoursUpdatedAt).toBeInstanceOf(Date);

    const enriched = await enrichGym(mapped, OWNER);
    expect(enriched.hours).toBe('Mon-Fri 7-22');
    // Assert the ISO string round-trips the mapped Date rather than a UTC
    // literal — the column is `timestamp` WITHOUT time zone, so a literal would
    // only match on a UTC host.
    expect(enriched.hoursUpdatedAt).toBe(mapped.hoursUpdatedAt!.toISOString());
    expect(new Date(enriched.hoursUpdatedAt!).getTime()).toBe(mapped.hoursUpdatedAt!.getTime());
  });
});

// ============================================================================
// Claims
// ============================================================================

describe('requestGymClaim — domain path', () => {
  it('creates a pending domain claim + emails a verification link when the email matches the website domain', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist', website: 'https://www.bonsist.bg' });

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'manager@bonsist.bg' } },
      authCtx(CLAIMANT),
    );

    expect(result).toEqual({ status: 'email_sent', email: 'manager@bonsist.bg' });

    const rows = Array.from(
      (await db.execute(sql`
        SELECT method, status, token_hash, claim_email, expires_at
        FROM gym_claims WHERE gym_id = ${claimGym.id}
      `)) as Iterable<{
        method: string;
        status: string;
        token_hash: string | null;
        claim_email: string | null;
        expires_at: string | Date | null;
      }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('domain');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].token_hash).toBeTruthy();
    expect(rows[0].claim_email).toBe('manager@bonsist.bg');
    expect(rows[0].expires_at).not.toBeNull();
    expect(new Date(rows[0].expires_at as string).getTime()).toBeGreaterThan(Date.now());

    expect(sendGymClaimVerificationEmail).toHaveBeenCalledTimes(1);
    // Args: (email, token, gymName, claimantName) — the claimant is named for informed consent.
    expect(sendGymClaimVerificationEmail).toHaveBeenCalledWith(
      'manager@bonsist.bg',
      expect.any(String),
      'Bonsist',
      expect.any(String),
    );
  });

  it('throws when the email domain does not match the gym website', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist', website: 'https://www.bonsist.bg' });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'someone@other.com' } },
        authCtx(CLAIMANT),
      ),
    ).rejects.toThrow(/doesn't match the gym's website/);

    const [countRow] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(countRow.c)).toBe(0);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
  });

  it('throws when the gym website is a free/consumer provider (no verifiable domain)', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Gmail Gym', website: 'https://gmail.com' });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'manager@gmail.com' } },
        authCtx(CLAIMANT),
      ),
    ).rejects.toThrow(/no verifiable website domain/);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #3431 — only a website the gym's OWNER put on the listing can auto-transfer
// ownership by email. Everything else falls back to admin review.
// ============================================================================

describe('requestGymClaim — the website must be owner-vouched to self-verify (#3431)', () => {
  it('blocks a colluding second account from riding a community-leader-set website into ownership', async () => {
    await insertUser(SYSTEM_OWNER);
    // A synced catalog listing: owned by the never-logged-in import user, no
    // website yet, carrying a kilter board so KILTER_LEADER's scoped role covers it.
    const catalogGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Catalog Wall', website: null });
    await insertBoard(catalogGym.id, SYSTEM_OWNER, 'kilter');

    // The leader may still curate a website — that stays allowed.
    const updated = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: catalogGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(KILTER_LEADER),
    );
    expect(updated.website).toBe('https://attacker-owned.example');
    expect(await gymWebsiteVouched(catalogGym.id)).toBe(false);

    // …but their second account cannot then self-verify into ownership.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: catalogGym.uuid, claimEmail: 'boss@attacker-owned.example' } },
        authCtx(SECOND_TARGET),
      ),
    ).rejects.toThrow(/hasn't been confirmed by the gym's owner/);

    expect(await claimRowCount(catalogGym.id)).toBe(0);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
    expect(await gymOwnerId(catalogGym.uuid)).toBe(SYSTEM_OWNER);
  });

  it('still lets an owner-set website self-serve by email', async () => {
    // Seeded UN-vouched on purpose: the owner's own updateGym is the only thing
    // that may flip the flag, so this reddens if that branch is removed.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Claim', website: null });

    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://www.bonsist.bg' } },
      authCtx(OWNER),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(true);

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'manager@bonsist.bg' } },
      authCtx(CLAIMANT),
    );

    expect(result).toEqual({ status: 'email_sent', email: 'manager@bonsist.bg' });
    const rows = Array.from(
      (await db.execute(sql`
        SELECT method, status, token_hash FROM gym_claims WHERE gym_id = ${claimGym.id}
      `)) as Iterable<{ method: string; status: string; token_hash: string | null }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('domain');
    expect(rows[0].token_hash).toBeTruthy();
    expect(sendGymClaimVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('vouches for a website the creator supplied at createGym time', async () => {
    const created = await socialGymMutations.createGym(
      null,
      { input: { name: 'New Wall', website: 'https://newwall.example' } },
      authCtx(PLAIN_USER),
    );

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: created.uuid, claimEmail: 'manager@newwall.example' } },
      authCtx(CLAIMANT),
    );

    expect(result).toEqual({ status: 'email_sent', email: 'manager@newwall.example' });
    expect(sendGymClaimVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps the vouch when an editor saves the form with the website untouched', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Editor Save', website: null });
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://bonsist.bg' } },
      authCtx(OWNER),
    );
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: claimGym.uuid, userId: EDITOR_TARGET } },
      authCtx(OWNER),
    );

    // Exactly what the manage form posts: every field, website unchanged.
    const edited = await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, description: 'New hours', website: 'https://bonsist.bg' } },
      authCtx(EDITOR_TARGET),
    );
    expect(edited.description).toBe('New hours');
    expect(await gymWebsiteVouched(claimGym.id)).toBe(true);

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'manager@bonsist.bg' } },
      authCtx(CLAIMANT),
    );
    expect(result).toEqual({ status: 'email_sent', email: 'manager@bonsist.bg' });
  });

  it('drops the vouch when an editor CHANGES the website', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Editor Rewrite', website: null });
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://bonsist.bg' } },
      authCtx(OWNER),
    );
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: claimGym.uuid, userId: EDITOR_TARGET } },
      authCtx(OWNER),
    );

    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(EDITOR_TARGET),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@attacker-owned.example' } },
        authCtx(CLAIMANT),
      ),
    ).rejects.toThrow(/hasn't been confirmed by the gym's owner/);
    expect(await claimRowCount(claimGym.id)).toBe(0);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();

    // KNOWN RESIDUAL, documented rather than fixed in code: a token minted while
    // the gym was still vouched keeps redeeming for its 24h life, because
    // verifyGymClaimByToken re-checks only the hash, status and expiry. That is
    // the in-flight window drizzle/0197_backfill_gym_website_vouched.sql closes
    // at deploy time by expiring pending domain claims on un-vouched gyms. It
    // stays open in code on purpose: a flag re-check at redemption would also
    // reject the legitimate SYSTEM-owned catalog claim covered above.
    await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'pending',
      claimEmail: 'manager@bonsist.bg',
      tokenHash: hashClaimToken('minted-before-the-editor-rewrote-it'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const redeemed = await verifyGymClaimByToken('minted-before-the-editor-rewrote-it');
    expect(redeemed.ok).toBe(true);
    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
  });

  it('does not re-vouch when the owner saves the form over an editor-set website', async () => {
    // Attack v2: the editor repoints the website, the un-vouch is invisible in the
    // manage UI, and the owner later saves the form for an unrelated edit — posting
    // the attacker's URL straight back. An unchanged website must not re-vouch, or
    // the escalation reopens with one extra step.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Owner Resave', website: null });
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://bonsist.bg' } },
      authCtx(OWNER),
    );
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: claimGym.uuid, userId: EDITOR_TARGET } },
      authCtx(OWNER),
    );
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(EDITOR_TARGET),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    // The owner fixes the hours; the form posts the attacker's website unchanged.
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, description: 'New hours', website: 'https://attacker-owned.example' } },
      authCtx(OWNER),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@attacker-owned.example' } },
        authCtx(SECOND_TARGET),
      ),
    ).rejects.toThrow(/hasn't been confirmed by the gym's owner/);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
  });

  it('un-vouches on a stale-snapshot save, so a concurrent owner vouch cannot be inherited', async () => {
    // TOCTOU. The "did the website change?" test used to run in JS against the
    // snapshot requireGymEditAccess read, while the flag was written by an
    // unconditional UPDATE. Interleave an owner commit between those two points
    // and the editor's save re-lands its own URL while the comparison says
    // "unchanged" — leaving the attacker's website flagged owner-vouched.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Race', website: null });
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: claimGym.uuid, userId: EDITOR_TARGET } },
      authCtx(OWNER),
    );
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(EDITOR_TARGET),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    // The editor saves the manage form again (posting the attacker URL it just
    // read back) while the owner sets and vouches the gym's real website in the
    // window between that read and the editor's write.
    await withInterceptedGymUpdate(
      () =>
        socialGymMutations.updateGym(
          null,
          { input: { gymUuid: claimGym.uuid, description: 'New hours', website: 'https://attacker-owned.example' } },
          authCtx(EDITOR_TARGET),
        ),
      async () => {
        await db.execute(
          sql`UPDATE gyms SET website = 'https://bonsist.bg', website_vouched_by_owner = true WHERE id = ${claimGym.id}`,
        );
      },
    );

    // Last writer still wins on the value itself — but it cannot inherit the
    // vouch, because the CASE compares against the row as the statement finds
    // it, not against the snapshot.
    expect(await gymWebsite(claimGym.id)).toBe('https://attacker-owned.example');
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@attacker-owned.example' } },
        authCtx(SECOND_TARGET),
      ),
    ).rejects.toThrow(/hasn't been confirmed by the gym's owner/);
    expect(await claimRowCount(claimGym.id)).toBe(0);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
  });

  it('writes the website and its vouch in one statement, deciding the change in SQL', async () => {
    // The invariant migration 0192 and the column comment both state: website and
    // website_vouched_by_owner are always written together, in the same statement.
    // Asserted on the payload the resolver actually handed Drizzle — a rebuilt
    // predicate would pass no matter what the resolver does.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Same Statement', website: 'https://bonsist.bg' });
    const { setPayloads } = await withInterceptedGymUpdate(() =>
      socialGymMutations.updateGym(
        null,
        { input: { gymUuid: claimGym.uuid, website: 'https://bonsist.bg' } },
        authCtx(OWNER),
      ),
    );

    expect(setPayloads).toHaveLength(1);
    const [payload] = setPayloads;
    expect(Object.keys(payload)).toContain('website');
    // Not a JS-side boolean and not absent: a CASE evaluated against the row.
    expect(is(payload.websiteVouchedByOwner, SQL)).toBe(true);

    const rendered = db.update(dbSchema.gyms).set(payload).toSQL().sql.toLowerCase().replace(/\s+/g, ' ');
    // The comparison reads the row's own website, and the untouched branch keeps
    // the row's own flag — neither side can come from the resolver's snapshot.
    expect(rendered).toMatch(
      /"website_vouched_by_owner" = case when "gyms"\."website" is distinct from \$\d+::text then \$\d+::boolean else "gyms"\."website_vouched_by_owner" end/,
    );
  });

  it('re-vouches when the owner deliberately retypes a different website', async () => {
    // The counterpart to the test above: the owner adopting a new URL is a real
    // change, so it must still vouch — otherwise the fix would strand every owner
    // who edits their website after an editor touched it.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Bonsist Owner Retype', website: null });
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: claimGym.uuid, userId: EDITOR_TARGET } },
      authCtx(OWNER),
    );
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(EDITOR_TARGET),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(false);

    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: claimGym.uuid, website: 'https://bonsist.bg' } },
      authCtx(OWNER),
    );
    expect(await gymWebsiteVouched(claimGym.id)).toBe(true);

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'manager@bonsist.bg' } },
      authCtx(CLAIMANT),
    );
    expect(result).toEqual({ status: 'email_sent', email: 'manager@bonsist.bg' });
  });

  it('leaves the admin-review fallback open on an un-vouched gym', async () => {
    await insertUser(SYSTEM_OWNER);
    const catalogGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Catalog Wall', website: null });
    await insertBoard(catalogGym.id, SYSTEM_OWNER, 'kilter');
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: catalogGym.uuid, website: 'https://attacker-owned.example' } },
      authCtx(KILTER_LEADER),
    );

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: catalogGym.uuid, message: 'I actually run this place' } },
      authCtx(CLAIMANT),
    );

    expect(result).toEqual({ status: 'admin_review' });
    const rows = Array.from(
      (await db.execute(sql`
        SELECT method, status FROM gym_claims WHERE gym_id = ${catalogGym.id}
      `)) as Iterable<{ method: string; status: string }>,
    );
    expect(rows).toEqual([{ method: 'admin', status: 'pending' }]);
    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(1);
  });
});

describe('requestGymClaim — admin-review path', () => {
  it('creates a pending admin claim + notifies the team when no email is given', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'No Website Gym' });

    const result = await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, message: 'I run this gym' } },
      authCtx(CLAIMANT),
    );

    expect(result).toEqual({ status: 'admin_review' });

    const rows = Array.from(
      (await db.execute(sql`
        SELECT method, status, message FROM gym_claims WHERE gym_id = ${claimGym.id}
      `)) as Iterable<{ method: string; status: string; message: string | null }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('admin');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].message).toBe('I run this gym');

    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(1);
    expect(sendGymClaimAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({ gymName: 'No Website Gym', gymUuid: claimGym.uuid }),
    );
  });

  it('rejects an unauthenticated caller', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Anon Claim Gym' });
    await expect(
      socialGymClaimMutations.requestGymClaim(null, { input: { gymUuid: claimGym.uuid, message: 'mine' } }, anonCtx()),
    ).rejects.toThrow();
    const [countRow] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(countRow.c)).toBe(0);
    expect(sendGymClaimAdminNotification).not.toHaveBeenCalled();
  });
});

describe('applyGymClaim / verifyGymClaimByToken — ownership transfer', () => {
  it('applyGymClaim transfers ownership, keeps a real prior owner as admin, and drops the claimant membership', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Real Gym', website: 'https://www.realgym.com' });
    // The claimant already has a leftover membership row that must be removed.
    await insertGymMember(claimGym.id, CLAIMANT, 'member');

    // Request a real domain claim, then apply the row we read back from the DB.
    await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@realgym.com' } },
      authCtx(CLAIMANT),
    );

    const [claimRow] = await db.select().from(dbSchema.gymClaims).where(eq(dbSchema.gymClaims.gymId, claimGym.id));
    expect(claimRow).toBeDefined();

    const applied = await applyGymClaim(claimRow);
    expect(applied).toEqual({
      outcome: 'applied',
      applied: {
        gymName: 'Real Gym',
        gymUuid: claimGym.uuid,
        gymSlug: claimGym.uuid, // insertGym seeds slug = uuid
        claimantUserId: CLAIMANT,
        claimEmail: 'boss@realgym.com',
        priorOwnerId: PRIOR_OWNER,
      },
    });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // Prior owner kept on as a gym admin.
    expect(await gymMemberRole(claimGym.id, PRIOR_OWNER)).toBe('admin');
    // Claimant's own prior membership row is gone (they own the gym now).
    expect(await gymMemberRole(claimGym.id, CLAIMANT)).toBeNull();
    expect(await claimStatus(claimRow.id)).toBe('approved');
  });

  it('verifyGymClaimByToken(token) transfers ownership and does NOT add the SYSTEM prior owner as a member', async () => {
    await insertUser(SYSTEM_OWNER);
    const claimGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Catalog Gym',
      website: 'https://www.catalog-gym.com',
    });

    const claimId = await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'pending',
      claimEmail: 'owner@catalog-gym.com',
      tokenHash: hashClaimToken('tok'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await verifyGymClaimByToken('tok');
    expect(result).toEqual({ ok: true, gymName: 'Catalog Gym', gymSlug: claimGym.uuid, gymUuid: claimGym.uuid });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // System placeholder owner is NOT retained as a member.
    expect(await gymMemberRole(claimGym.id, SYSTEM_OWNER)).toBeNull();
    expect(await claimStatus(claimId)).toBe('approved');
    // Best-effort approval email fired (claimEmail present).
    expect(sendGymClaimApprovedEmail).toHaveBeenCalledWith('owner@catalog-gym.com', 'Catalog Gym');
    // The claimant gets an in-app notification deep-linking to the gym (by UUID), no actor.
    const domainNotifications = await claimApprovedNotifications(CLAIMANT);
    expect(domainNotifications).toEqual([{ entity_type: 'gym', entity_id: claimGym.uuid, actor_id: null }]);
  });

  it('verifyGymClaimByToken rejects an unknown token without transferring anything', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Untouched Gym' });
    const result = await verifyGymClaimByToken('not-a-real-token');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await gymOwnerId(claimGym.uuid)).toBe(OWNER);
  });

  it('verifyGymClaimByToken rejects and expires a stale token without transferring', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Expired Gym', website: 'https://www.expiredgym.com' });
    const claimId = await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'pending',
      claimEmail: 'x@expiredgym.com',
      tokenHash: hashClaimToken('expiredtok'),
      expiresAt: new Date(Date.now() - 60 * 1000), // already lapsed
    });

    const result = await verifyGymClaimByToken('expiredtok');
    expect(result).toEqual({ ok: false, reason: 'expired' });

    // No ownership change, and the row is flipped to 'expired' so a later click can't reuse it.
    expect(await gymOwnerId(claimGym.uuid)).toBe(OWNER);
    expect(await claimStatus(claimId)).toBe('expired');
    expect(sendGymClaimApprovedEmail).not.toHaveBeenCalled();
  });
});

describe('reviewGymClaim (admin-gated)', () => {
  it('rejects a non-admin caller', async () => {
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Review Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(PLAIN_USER)),
    ).rejects.toThrow(/Admin role required/);

    // No transfer happened.
    expect(await gymOwnerId(claimGym.uuid)).toBe(OWNER);
    expect(await claimStatus(claimId)).toBe('pending');
  });

  it('admin approve transfers ownership', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Approve Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    expect(await gymMemberRole(claimGym.id, PRIOR_OWNER)).toBe('admin');
    expect(await claimStatus(claimId)).toBe('approved');
    // The displaced real owner is notified.
    expect(sendGymClaimOwnershipLostEmail).toHaveBeenCalledWith(`${PRIOR_OWNER}@test.com`, 'Approve Gym');
    // The claimant gets an in-app "you now manage this gym" notification.
    const adminNotifications = await claimApprovedNotifications(CLAIMANT);
    expect(adminNotifications).toEqual([{ entity_type: 'gym', entity_id: claimGym.uuid, actor_id: null }]);
  });

  it('admin deny marks the claim denied without transferring', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Deny Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'deny' } }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);

    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
    expect(await claimStatus(claimId)).toBe('denied');
    // A denied claim transfers nothing, so no approval notification fires.
    expect(await claimApprovedNotifications(CLAIMANT)).toEqual([]);
  });
});

describe('pendingGymClaims (admin-gated)', () => {
  it('rejects a non-admin caller', async () => {
    await expect(socialGymClaimQueries.pendingGymClaims(null, { input: {} }, authCtx(PLAIN_USER))).rejects.toThrow(
      /Admin role required/,
    );
  });

  it('lists pending claims for an admin', async () => {
    const claimGymA = await insertGym({ ownerId: OWNER, name: 'Pending A' });
    const claimGymB = await insertGym({ ownerId: PRIOR_OWNER, name: 'Pending B' });
    await insertClaim({ gymId: claimGymA.id, claimantUserId: CLAIMANT, method: 'admin' });
    await insertClaim({ gymId: claimGymB.id, claimantUserId: PLAIN_USER, method: 'admin' });
    // A resolved claim must NOT show up.
    await insertClaim({ gymId: claimGymA.id, claimantUserId: SECOND_TARGET, method: 'admin', status: 'approved' });

    const result = await socialGymClaimQueries.pendingGymClaims(null, { input: {} }, authCtx(GLOBAL_ADMIN));

    expect(result.totalCount).toBe(2);
    expect(result.claims).toHaveLength(2);
    expect(result.claims.every((claim) => claim.status === 'pending')).toBe(true);
    expect(result.claims.map((claim) => claim.gymName).sort()).toEqual(['Pending A', 'Pending B']);
  });
});

// ============================================================================
// Security regressions (review findings)
// ============================================================================

describe('claim security hardening', () => {
  it('blocks the domain path for anyone who can already edit the gym (privilege-escalation guard)', async () => {
    // A gym with a kilter board so a kilter community_leader covers it, plus a website.
    const claimGym = await insertGym({
      ownerId: PRIOR_OWNER,
      name: 'Escalate Gym',
      website: 'https://www.escalate.com',
    });
    await insertBoard(claimGym.id, PRIOR_OWNER, 'kilter');

    // A covering community leader could rewrite `website` then self-claim — refuse the domain path.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'me@escalate.com' } },
        authCtx(KILTER_LEADER),
      ),
    ).rejects.toThrow(/already have edit access/);

    // Same for a gym editor member.
    await insertGymMember(claimGym.id, EDITOR_TARGET, 'editor');
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'me@escalate.com' } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/already have edit access/);

    // And a gym admin member (of THIS gym).
    await insertGymMember(claimGym.id, GYM_ADMIN_MEMBER, 'admin');
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'me@escalate.com' } },
        authCtx(GYM_ADMIN_MEMBER),
      ),
    ).rejects.toThrow(/already have edit access/);

    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();

    // A plain user with no edit access can still domain-claim.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'me@escalate.com' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'email_sent', email: 'me@escalate.com' });
  });

  it('refuses to claim a private gym', async () => {
    const privateGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Private Gym', isPublic: false });
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: privateGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).rejects.toThrow(/private/);
  });

  it('keeps domain claims out of the admin queue and unapprovable by an admin', async () => {
    const claimGym = await insertGym({
      ownerId: PRIOR_OWNER,
      name: 'Domain Only',
      website: 'https://www.domainonly.com',
    });
    const domainClaimId = await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'pending',
      claimEmail: 'x@domainonly.com',
      tokenHash: hashClaimToken('dtok'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Not listed in the admin review queue (domain claims self-verify).
    const queue = await socialGymClaimQueries.pendingGymClaims(null, { input: {} }, authCtx(GLOBAL_ADMIN));
    expect(queue.claims.some((claim) => claim.id === String(domainClaimId))).toBe(false);

    // An admin cannot approve it by id — bypassing the domain proof.
    await expect(
      socialGymClaimMutations.reviewGymClaim(
        null,
        { input: { claimId: domainClaimId, decision: 'approve' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/not found or already resolved/);
    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
  });

  it('rejects granting write access to the gym owner', async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(null, { input: { gymUuid, userId: OWNER } }, authCtx(GLOBAL_ADMIN)),
    ).rejects.toThrow(/owner already has full access/);
    expect(await gymMemberRole(gymId, OWNER)).toBeNull();
  });

  it('does not re-send a verification email for a duplicate pending domain claim', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Dedupe Gym', website: 'https://www.dedupe.com' });
    const input = { gymUuid: claimGym.uuid, claimEmail: 'me@dedupe.com' };

    await socialGymClaimMutations.requestGymClaim(null, { input }, authCtx(CLAIMANT));
    await socialGymClaimMutations.requestGymClaim(null, { input }, authCtx(CLAIMANT));

    // Second identical request is a no-op re-send; still one row, one email.
    expect(sendGymClaimVerificationEmail).toHaveBeenCalledTimes(1);
    const [countRow] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(countRow.c)).toBe(1);
  });

  it('re-requesting a domain claim with a different email replaces the row and invalidates the old token', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Retoken Gym', website: 'https://www.retoken.com' });

    // First request with email A — capture the emitted token from the mailer args.
    await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'a@retoken.com' } },
      authCtx(CLAIMANT),
    );
    const firstToken = vi.mocked(sendGymClaimVerificationEmail).mock.calls[0][1];

    // Second request with a DIFFERENT email replaces the pending row (fresh token).
    await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'b@retoken.com' } },
      authCtx(CLAIMANT),
    );
    const secondToken = vi.mocked(sendGymClaimVerificationEmail).mock.calls[1][1];
    expect(secondToken).not.toBe(firstToken);

    // Exactly one pending row remains, carrying the new email.
    const rows = await db.select().from(dbSchema.gymClaims).where(eq(dbSchema.gymClaims.gymId, claimGym.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].claimEmail).toBe('b@retoken.com');

    // The old token no longer resolves — its row was replaced, not left live.
    expect(await verifyGymClaimByToken(firstToken)).toEqual({ ok: false, reason: 'invalid' });
    // The new token still transfers ownership.
    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
    const applied = await verifyGymClaimByToken(secondToken);
    expect(applied).toEqual({ ok: true, gymName: 'Retoken Gym', gymSlug: claimGym.uuid, gymUuid: claimGym.uuid });
    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
  });

  it('upgrades (not preserves) a prior owner who already had a lower-role membership row to admin', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Upgrade Gym', website: 'https://www.upgrade.com' });
    // Contrived: the prior owner also has a stale lower-role membership row.
    await insertGymMember(claimGym.id, PRIOR_OWNER, 'member');
    const claimId = await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'pending',
      claimEmail: 'x@upgrade.com',
      tokenHash: hashClaimToken('utok'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await verifyGymClaimByToken('utok');

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // Upgraded to admin, not left at 'member'.
    expect(await gymMemberRole(claimGym.id, PRIOR_OWNER)).toBe('admin');
    expect(await claimStatus(claimId)).toBe('approved');
  });

  it('does not leave a stuck pending row when the verification email fails to send', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'SMTP Gym', website: 'https://www.smtpgym.com' });
    const input = { gymUuid: claimGym.uuid, claimEmail: 'me@smtpgym.com' };

    // First attempt: the mailer is down.
    vi.mocked(sendGymClaimVerificationEmail).mockRejectedValueOnce(new Error('SMTP down'));
    await expect(socialGymClaimMutations.requestGymClaim(null, { input }, authCtx(CLAIMANT))).rejects.toThrow(
      /SMTP down/,
    );

    // No pending row lingers to block a retry.
    const [afterFail] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(afterFail.c)).toBe(0);

    // Retry succeeds now that the mailer recovered.
    await expect(socialGymClaimMutations.requestGymClaim(null, { input }, authCtx(CLAIMANT))).resolves.toEqual({
      status: 'email_sent',
      email: 'me@smtpgym.com',
    });
    const [afterOk] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(afterOk.c)).toBe(1);
  });

  it('reviewGymClaim surfaces an error instead of a false success when the gym is gone', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Vanishing Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });
    // Soft-delete the gym after the claim exists.
    await db.execute(sql`UPDATE gyms SET deleted_at = now() WHERE id = ${claimGym.id}`);

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(GLOBAL_ADMIN)),
    ).rejects.toThrow(/may have been removed/);
  });

  it('blocks the admin-review path too for anyone who can already edit the gym', async () => {
    // A gym with a kilter board so a kilter community_leader covers it.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Admin-Path Escalate' });
    await insertBoard(claimGym.id, PRIOR_OWNER, 'kilter');
    await insertGymMember(claimGym.id, EDITOR_TARGET, 'editor');

    // The admin-review fallback (no claimEmail) is gated at the top too, not just
    // the domain path — an editor can't queue an ownership claim they can't win.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'let me in' } },
        authCtx(EDITOR_TARGET),
      ),
    ).rejects.toThrow(/already have edit access/);
    // A covering community leader is refused the same way.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'let me in' } },
        authCtx(KILTER_LEADER),
      ),
    ).rejects.toThrow(/already have edit access/);

    // Nothing queued, no admin notified.
    const [countRow] = Array.from(
      (await db.execute(sql`SELECT count(*)::int AS c FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        c: number;
      }>,
    );
    expect(Number(countRow.c)).toBe(0);
    expect(sendGymClaimAdminNotification).not.toHaveBeenCalled();

    // A plain user with no edit access can still file for admin review.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'genuinely mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });
  });

  it('still queues an admin claim when the notification email fails (best-effort)', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Notify-Down Gym' });
    // The admin notification is fire-and-forget: a send failure must NOT roll the
    // request back into an error, or the committed row + dedup check would strand
    // the admin on retry. The queue is the source of truth.
    vi.mocked(sendGymClaimAdminNotification).mockRejectedValueOnce(new Error('SMTP down'));

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });

    // The claim is committed and visible to an admin despite the failed email.
    const rows = Array.from(
      (await db.execute(sql`SELECT status, method FROM gym_claims WHERE gym_id = ${claimGym.id}`)) as Iterable<{
        status: string;
        method: string;
      }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', method: 'admin' });
  });
});

// ============================================================================
// Auto-approval of admin-review claims (gym_claim_auto_approve)
// ============================================================================

/** Turn the global auto-approve setting on/off by writing the row directly. */
const setAutoApprove = (on: boolean) =>
  db.execute(sql`
    INSERT INTO community_settings (scope, scope_key, key, value, created_at, updated_at)
    VALUES ('global', '', 'gym_claim_auto_approve', ${on ? '1' : '0'}, now(), now())
    ON CONFLICT (scope, scope_key, key) DO UPDATE SET value = EXCLUDED.value
  `);

const claimRows = async (gymId: number) =>
  Array.from(
    (await db.execute(sql`
      SELECT method, status, reviewed_by FROM gym_claims WHERE gym_id = ${gymId}
    `)) as Iterable<{ method: string; status: string; reviewed_by: string | null }>,
  );

const gymSyncFrozenAt = async (gymUuid: string): Promise<Date | null> => {
  const result = await db.execute(sql`SELECT sync_frozen_at FROM gyms WHERE uuid = ${gymUuid} LIMIT 1`);
  return Array.from(result as Iterable<{ sync_frozen_at: Date | null }>)[0].sync_frozen_at;
};

describe('requestGymClaim — auto-approval', () => {
  it('leaves the claim queued when the setting is off (default)', async () => {
    const claimGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Unclaimed Listing' });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(SYSTEM_OWNER);
    expect(await claimRows(claimGym.id)).toEqual([expect.objectContaining({ method: 'admin', status: 'pending' })]);
    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('hands over an unclaimed (system-owned) listing on the spot when the setting is on', async () => {
    await setAutoApprove(true);
    const claimGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Auto Listing' });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'I run this' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'approved' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // Taking ownership freezes the listing against location-sync clobber.
    expect(await gymSyncFrozenAt(claimGym.uuid)).not.toBeNull();

    // Auto-approved rows carry no reviewer — that's how they're told apart.
    expect(await claimRows(claimGym.id)).toEqual([
      expect.objectContaining({ method: 'admin', status: 'approved', reviewed_by: null }),
    ]);

    // No human was asked to look at it.
    expect(sendGymClaimAdminNotification).not.toHaveBeenCalled();

    // The claimant is told they now manage the gym.
    const notifications = await claimApprovedNotifications(CLAIMANT);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].entity_id).toBe(claimGym.uuid);
  });

  it('still queues a claim on a gym a real person owns, even with the setting on', async () => {
    await setAutoApprove(true);
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Someone Elses Gym' });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'let me in' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });

    // The whole point of the scope limit: no silent takeover.
    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
    expect(await claimRows(claimGym.id)).toEqual([expect.objectContaining({ method: 'admin', status: 'pending' })]);
    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(1);
    expect(sendGymClaimOwnershipLostEmail).not.toHaveBeenCalled();
  });

  it('approves a claim that was already queued before the setting was turned on', async () => {
    const claimGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Queued Then Enabled' });

    // Queued while auto-approval was still off.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });

    await setAutoApprove(true);

    // Re-requesting now goes through instead of hitting the dedup early return.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'approved' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    expect(await claimRows(claimGym.id)).toEqual([
      expect.objectContaining({ method: 'admin', status: 'approved', reviewed_by: null }),
    ]);
  });

  it('survives two users racing for the same unclaimed gym — one wins, neither errors', async () => {
    await setAutoApprove(true);
    const claimGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Contested Listing' });

    // Real concurrency, so the loser can take either degradation path inside
    // applyGymClaim: it may see the new owner at the SELECT (owner-guard returns
    // null), or pass the SELECT and lose the guarded UPDATE (throws, rolls back).
    // Which one it takes is timing-dependent; the invariant below is not.
    const outcomes = await Promise.allSettled([
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, message: 'no, mine' } },
        authCtx(PLAIN_USER),
      ),
    ]);

    // Neither caller gets a server error — a claim that ends up queued must be
    // reported as queued, not as a failure.
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    const statuses = outcomes
      .map((outcome) => (outcome.status === 'fulfilled' ? (outcome.value as { status: string }).status : 'rejected'))
      .sort();
    expect(statuses).toEqual(['admin_review', 'approved']);

    // Exactly one transfer happened, and the winner is whoever got 'approved'.
    const owner = await gymOwnerId(claimGym.uuid);
    expect([CLAIMANT, PLAIN_USER]).toContain(owner);

    const rows = await claimRows(claimGym.id);
    expect(rows.filter((row) => row.status === 'approved')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
  });

  it('queues instead of erroring once the auto-approve rate limit is spent', async () => {
    await setAutoApprove(true);

    // Every bucket `applyRateLimit` keeps is keyed `${userId}:${operation}`, and
    // its tier-1 in-process bucket is NOT reset between tests. Claiming as a
    // brand-new user each run guarantees an empty budget no matter what ran
    // first — pinning this to a shared fixture account would make the expected
    // sequence order-dependent.
    //
    // Tier 1 being per-process is a test-isolation concern only: authenticated
    // callers also pass through tier 2, a shared Redis bucket on the same key
    // (`shared/helpers.ts`), so the production cap is global across instances.
    const claimant = `gw-rate-limited-${uuidv4()}`;
    await insertUser(claimant);

    const gyms = await Promise.all(
      [1, 2, 3, 4].map((index) => insertGym({ ownerId: SYSTEM_OWNER, name: `Rate Limited ${index}` })),
    );

    const results: string[] = [];
    for (const gym of gyms) {
      const result = (await socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: gym.uuid, message: 'mine' } },
        authCtx(claimant),
      )) as { status: string };
      results.push(result.status);
    }

    // The limit caps instant hand-overs at 3; the 4th must fall back to the
    // queue rather than reject — its claim row is already committed, so an
    // error would tell the user their request failed when it didn't.
    expect(results).toEqual(['approved', 'approved', 'approved', 'admin_review']);

    expect(await gymOwnerId(gyms[3].uuid)).toBe(SYSTEM_OWNER);
    expect(await claimRows(gyms[3].id)).toEqual([expect.objectContaining({ method: 'admin', status: 'pending' })]);
  });

  it('never leaks the internal race message out of a manual approve', async () => {
    // Two admin-method claims on one gym, both approved at once. Whichever way
    // the transfers interleave, the reviewer must only ever see the curated
    // message — applyGymClaim's internal "ownership changed" throw is an
    // implementation detail and must not reach the admin panel.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Double Reviewed' });
    const firstClaim = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });
    const secondClaim = await insertClaim({ gymId: claimGym.id, claimantUserId: PLAIN_USER, method: 'admin' });

    const outcomes = await Promise.allSettled([
      socialGymClaimMutations.reviewGymClaim(
        null,
        { input: { claimId: firstClaim, decision: 'approve' } },
        authCtx(GLOBAL_ADMIN),
      ),
      socialGymClaimMutations.reviewGymClaim(
        null,
        { input: { claimId: secondClaim, decision: 'approve' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ]);

    // Two curated messages are possible and which one the loser gets is pure
    // timing: it either loses the guarded UPDATE (already-resolved wording), or
    // reads the winner's approved row first and is refused as superseded. Both
    // are written for the reviewer; neither is the internal race message.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect([
          'Could not approve this claim — the gym may have been removed or it was already resolved',
          'This gym changed hands after the claim was filed.',
        ]).toContain(String(outcome.reason?.message));
      }
    }

    // At least one approval landed, and the gym belongs to a claimant.
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect([CLAIMANT, PLAIN_USER]).toContain(await gymOwnerId(claimGym.uuid));
  });

  it('does not auto-approve a domain claim — it still has to prove the domain', async () => {
    await setAutoApprove(true);
    // Owner-vouched on purpose: that is now the precondition for the email path
    // existing at all, so it is what keeps this test about auto-approval rather
    // than about the vouch guard. The un-vouched case is the next test.
    const claimGym = await insertGym({
      ownerId: OWNER,
      name: 'Domain Listing',
      website: 'https://www.domainlisting.com',
      websiteVouchedByOwner: true,
    });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@domainlisting.com' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'email_sent', email: 'boss@domainlisting.com' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(OWNER);
    expect(await claimRows(claimGym.id)).toEqual([expect.objectContaining({ method: 'domain', status: 'pending' })]);
    expect(sendGymClaimVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses the email path on a SYSTEM-owned gym and points at admin review', async () => {
    await setAutoApprove(true);
    // A synced catalog gym's owner is the never-logged-in import user, so nobody
    // can ever vouch its website. The domain path is closed for it permanently —
    // the deliberate cost of closing the editor-repoints-the-website escalation.
    const claimGym = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Catalog Listing',
      website: 'https://www.cataloglisting.com',
    });

    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@cataloglisting.com' } },
        authCtx(CLAIMANT),
      ),
    ).rejects.toThrow(/hasn't been confirmed by the gym's owner/);

    expect(await gymOwnerId(claimGym.uuid)).toBe(SYSTEM_OWNER);
    expect(await claimRows(claimGym.id)).toEqual([]);
    expect(sendGymClaimVerificationEmail).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Claim funnel: outcome notifications, the pending-claim cap, and the viewer's
// own pending claim (#4377)
// ============================================================================

describe('approving a claim lands the same way whichever path approves it', () => {
  it('auto-approval, admin approval and applyGymClaim itself agree, differing only in reviewed_by', async () => {
    // Same starting shape for both: an unclaimed catalog listing, one claimant.
    // Auto-approval is the only path that ever runs unattended, so if the two
    // ever drift, an admin-approved gym silently stops being sync-frozen and
    // the location sync starts overwriting the new owner's edits.
    await setAutoApprove(true);
    const autoGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Parity Auto' });
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: autoGym.uuid, message: 'mine' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'approved' });

    await setAutoApprove(false);
    const reviewedGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Parity Reviewed' });
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: reviewedGym.uuid, message: 'mine too' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toEqual({ status: 'admin_review' });
    const [queued] = await db.select().from(dbSchema.gymClaims).where(eq(dbSchema.gymClaims.gymId, reviewedGym.id));
    await expect(
      socialGymClaimMutations.reviewGymClaim(
        null,
        { input: { claimId: queued.id, decision: 'approve' } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).resolves.toBe(true);

    // Third arm: applyGymClaim itself — the one function both paths are
    // supposed to delegate to, and the only reason the two above can be
    // expected to agree at all. If either mutation ever grows its own transfer
    // logic, its end state drifts from this one and this test fails, which is
    // the drift it exists to catch.
    const directGym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Parity Direct' });
    const directClaimId = await insertClaim({ gymId: directGym.id, claimantUserId: CLAIMANT, method: 'admin' });
    const [directClaim] = await db.select().from(dbSchema.gymClaims).where(eq(dbSchema.gymClaims.id, directClaimId));
    expect(await applyGymClaim(directClaim, { requireCurrentOwnerId: SYSTEM_OWNER })).toMatchObject({
      outcome: 'applied',
    });

    // Identical end state...
    expect(await gymOwnerId(autoGym.uuid)).toBe(CLAIMANT);
    expect(await gymOwnerId(reviewedGym.uuid)).toBe(CLAIMANT);
    expect(await gymOwnerId(directGym.uuid)).toBe(CLAIMANT);
    expect(await gymSyncFrozenAt(autoGym.uuid)).not.toBeNull();
    expect(await gymSyncFrozenAt(reviewedGym.uuid)).not.toBeNull();
    expect(await gymSyncFrozenAt(directGym.uuid)).not.toBeNull();
    expect(await claimStatus(queued.id)).toBe('approved');
    expect(await claimStatus(directClaimId)).toBe('approved');

    // ...except for who is on record as having decided it.
    expect(await claimRows(autoGym.id)).toEqual([expect.objectContaining({ status: 'approved', reviewed_by: null })]);
    expect(await claimRows(reviewedGym.id)).toEqual([
      expect.objectContaining({ status: 'approved', reviewed_by: GLOBAL_ADMIN }),
    ]);
  });
});

describe('the claimant hears the outcome', () => {
  it('emails an admin-path claimant at their account address on approval', async () => {
    // The claim row carries no claimEmail (that column is the domain path's
    // verification address), so before the account-email fallback every admin
    // approval mailed nobody at all.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Approved By Hand' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);

    expect(sendGymClaimApprovedEmail).toHaveBeenCalledWith(`${CLAIMANT}@test.com`, 'Approved By Hand');
  });

  it('emails a denied claimant instead of leaving them waiting forever', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Denied Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'deny' } }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);

    expect(sendGymClaimDeniedEmail).toHaveBeenCalledWith(`${CLAIMANT}@test.com`, 'Denied Gym');
    expect(sendGymClaimApprovedEmail).not.toHaveBeenCalled();
    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
  });

  it('never marks a claim denied after it has already been approved', async () => {
    // A deny racing an approve on the same claim. Without the `status =
    // 'pending'` guard on the deny UPDATE, the deny lands AFTER the transfer
    // and the row reads `denied` on a gym that changed hands.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Raced Decision' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    const outcomes = await Promise.allSettled([
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(GLOBAL_ADMIN)),
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'deny' } }, authCtx(GLOBAL_ADMIN)),
    ]);

    // One decision, not two.
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    // Whichever won, the row and the ownership agree — that is the invariant
    // the guard buys, and it holds regardless of how the two interleaved.
    const finalStatus = await claimStatus(claimId);
    const finalOwner = await gymOwnerId(claimGym.uuid);
    if (finalStatus === 'approved') {
      expect(finalOwner).toBe(CLAIMANT);
    } else {
      expect(finalStatus).toBe('denied');
      expect(finalOwner).toBe(PRIOR_OWNER);
    }
  });
});

describe('pending claims are capped per user, and the admin inbox is not flooded', () => {
  it(`refuses claim ${MAX_PENDING_CLAIMS_PER_USER + 1} while the first ${MAX_PENDING_CLAIMS_PER_USER} are still open`, async () => {
    // Fresh account: applyRateLimit's tier-1 bucket is per-process and never
    // reset between tests, so a shared fixture user would make this order-dependent.
    const hoarder = `gw-hoarder-${uuidv4()}`;
    await insertUser(hoarder);

    const seeded = await Promise.all(
      Array.from({ length: MAX_PENDING_CLAIMS_PER_USER }, (_, index) =>
        insertGym({ ownerId: PRIOR_OWNER, name: `Hoarded ${index}` }),
      ),
    );
    for (const gym of seeded) {
      await insertClaim({ gymId: gym.id, claimantUserId: hoarder, method: 'admin' });
    }

    const oneTooMany = await insertGym({ ownerId: PRIOR_OWNER, name: 'One Too Many' });
    const rejection = await socialGymClaimMutations
      .requestGymClaim(null, { input: { gymUuid: oneTooMany.uuid, message: 'this one as well' } }, authCtx(hoarder))
      .catch((error: unknown) => error);
    expect(String((rejection as Error).message)).toMatch(/waiting on review/);
    // Carries a machine-readable code, like the rate limiter, so a client can
    // branch on the cap instead of matching English.
    expect((rejection as GraphQLError).extensions).toMatchObject({
      code: GYM_CLAIM_LIMIT_CODE,
      limit: MAX_PENDING_CLAIMS_PER_USER,
    });
    expect(await claimRowCount(oneTooMany.id)).toBe(0);

    // Re-submitting on a gym they already have queued replaces that row rather
    // than adding one, so the cap must not block it.
    await expect(
      socialGymClaimMutations.requestGymClaim(
        null,
        { input: { gymUuid: seeded[0].uuid, message: 'still mine' } },
        authCtx(hoarder),
      ),
    ).resolves.toEqual({ status: 'admin_review' });
  });

  it('carries the backlog in the mail rather than going quiet on the second claim', async () => {
    const serialClaimer = `gw-serial-${uuidv4()}`;
    await insertUser(serialClaimer);
    const first = await insertGym({ ownerId: PRIOR_OWNER, name: 'Backlog One' });
    const second = await insertGym({ ownerId: PRIOR_OWNER, name: 'Backlog Two' });

    for (const gym of [first, second]) {
      await expect(
        socialGymClaimMutations.requestGymClaim(null, { input: { gymUuid: gym.uuid } }, authCtx(serialClaimer)),
      ).resolves.toEqual({ status: 'admin_review' });
    }

    // EVERY queued claim mails. Skipping the later ones would mean one swallowed
    // SMTP failure mutes an account's whole queue — the batching is in the
    // content (the "N waiting" count), not in the delivery.
    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(2);
    expect(sendGymClaimAdminNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ gymName: 'Backlog One', pendingClaimCount: 1 }),
    );
    expect(sendGymClaimAdminNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ gymName: 'Backlog Two', pendingClaimCount: 2 }),
    );
  });

  it('keeps mailing after a send fails, instead of muting the account for good', async () => {
    // The regression this guards: a post-insert "do they already have claims?"
    // check paired with a deliberately swallowed send meant one SMTP blip
    // silenced every claim that account would ever file.
    const unluckyClaimer = `gw-smtp-blip-${uuidv4()}`;
    await insertUser(unluckyClaimer);
    const first = await insertGym({ ownerId: PRIOR_OWNER, name: 'Blip One' });
    const second = await insertGym({ ownerId: PRIOR_OWNER, name: 'Blip Two' });

    vi.mocked(sendGymClaimAdminNotification).mockRejectedValueOnce(new Error('SMTP down'));

    await expect(
      socialGymClaimMutations.requestGymClaim(null, { input: { gymUuid: first.uuid } }, authCtx(unluckyClaimer)),
    ).resolves.toEqual({ status: 'admin_review' });
    await expect(
      socialGymClaimMutations.requestGymClaim(null, { input: { gymUuid: second.uuid } }, authCtx(unluckyClaimer)),
    ).resolves.toEqual({ status: 'admin_review' });

    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(2);
    expect(await claimRowCount(first.id)).toBe(1);
    expect(await claimRowCount(second.id)).toBe(1);
  });

  it('does not let an expired domain claim hold a slot forever', async () => {
    // Nothing sweeps expired rows — the only flip to `expired` happens when
    // someone clicks the dead link — so a cap that counted them would strand
    // the claimant with no way to free the slot.
    const stuckClaimer = `gw-stuck-${uuidv4()}`;
    await insertUser(stuckClaimer);

    const seeded = await Promise.all(
      Array.from({ length: MAX_PENDING_CLAIMS_PER_USER }, (_, index) =>
        insertGym({ ownerId: PRIOR_OWNER, name: `Stale ${index}` }),
      ),
    );
    for (const gym of seeded) {
      await insertClaim({
        gymId: gym.id,
        claimantUserId: stuckClaimer,
        method: 'domain',
        claimEmail: 'boss@stale.com',
        tokenHash: hashClaimToken(`stale-${gym.id}`),
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
    }

    const freshGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Fresh Claim' });
    await expect(
      socialGymClaimMutations.requestGymClaim(null, { input: { gymUuid: freshGym.uuid } }, authCtx(stuckClaimer)),
    ).resolves.toEqual({ status: 'admin_review' });
  });
});

describe('Gym.myPendingClaim (viewer-scoped)', () => {
  it('returns the viewer’s own pending claim and nothing else', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Under Review Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, authCtx(CLAIMANT)),
    ).resolves.toEqual({ id: String(claimId), method: 'admin', createdAt: expect.any(String) });

    // Another signed-in climber's view of the same gym is unaffected...
    await expect(
      gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, authCtx(PLAIN_USER)),
    ).resolves.toBeNull();
    // ...and so is an anonymous one.
    await expect(gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, anonCtx())).resolves.toBeNull();
  });

  it('goes back to null once the claim is decided, so the CTA returns', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Decided Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'deny' } }, authCtx(GLOBAL_ADMIN));

    await expect(
      gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, authCtx(CLAIMANT)),
    ).resolves.toBeNull();
  });

  it('stops reporting an expired domain claim, so the claimant is not trapped', async () => {
    // The gym page swaps the claim CTA for "check your inbox" while this is
    // non-null. Nothing sweeps expired rows, so if the resolver kept returning
    // one, the page would point at a dead link forever with no way back to the
    // dialog — strictly worse than showing no notice at all.
    const claimGym = await insertGym({ ownerId: OWNER, name: 'Lapsed Link Gym', website: 'https://www.lapsed.com' });
    await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      claimEmail: 'boss@lapsed.com',
      tokenHash: hashClaimToken('lapsed-token'),
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    await expect(
      gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, authCtx(CLAIMANT)),
    ).resolves.toBeNull();
  });

  it('reports the domain method, so the page can say "check your inbox"', async () => {
    const claimGym = await insertGym({
      ownerId: OWNER,
      name: 'Domain Pending Gym',
      website: 'https://www.domainpending.com',
      websiteVouchedByOwner: true,
    });

    await socialGymClaimMutations.requestGymClaim(
      null,
      { input: { gymUuid: claimGym.uuid, claimEmail: 'boss@domainpending.com' } },
      authCtx(CLAIMANT),
    );

    await expect(
      gymClaimFieldResolvers.myPendingClaim({ uuid: claimGym.uuid }, {}, authCtx(CLAIMANT)),
    ).resolves.toEqual(expect.objectContaining({ method: 'domain' }));
  });
});

describe('gym community settings — admin-only', () => {
  const setInput = (value: string) => ({
    input: { scope: 'global', scopeKey: '', key: 'gym_claim_auto_approve', value },
  });

  // A GLOBAL community_leader — the board-scoped KILTER_LEADER can't write a
  // global-scope setting at all, so it would pass the gym test for the wrong
  // reason. This user can write the non-gym keys, which is what makes the gym
  // rejection below meaningful.
  const insertGlobalLeader = () => insertRole(PLAIN_USER, 'community_leader', null);

  it('rejects a global community_leader writing a gym setting', async () => {
    await insertGlobalLeader();

    await expect(
      socialCommunitySettingsMutations.setCommunitySettings(null, setInput('1'), authCtx(PLAIN_USER)),
    ).rejects.toThrow(/admin/i);

    const rows = Array.from(
      (await db.execute(sql`SELECT value FROM community_settings WHERE key = 'gym_claim_auto_approve'`)) as Iterable<{
        value: string;
      }>,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a global admin write a gym setting', async () => {
    const result = await socialCommunitySettingsMutations.setCommunitySettings(
      null,
      setInput('1'),
      authCtx(GLOBAL_ADMIN),
    );
    expect(result).toMatchObject({ key: 'gym_claim_auto_approve', value: '1' });
  });

  it('rejects a board-scoped admin and hides gym settings from them', async () => {
    // `admin` scoped to a single board type. Gym settings are global config and
    // both gates resolve them without a board type, so this role must not
    // qualify — which is exactly why the /admin Gyms tab is hidden from it.
    await insertRole(PLAIN_USER, 'admin', 'kilter');
    await setAutoApprove(true);

    await expect(
      socialCommunitySettingsMutations.setCommunitySettings(null, setInput('0'), authCtx(PLAIN_USER)),
    ).rejects.toThrow(/admin/i);

    const visible = await socialCommunitySettingsQueries.communitySettings(
      null,
      { scope: 'global', scopeKey: '' },
      authCtx(PLAIN_USER),
    );
    expect(visible.map((setting) => setting.key)).not.toContain('gym_claim_auto_approve');
  });

  it('still lets a global community_leader write a non-gym setting', async () => {
    await insertGlobalLeader();

    const result = await socialCommunitySettingsMutations.setCommunitySettings(
      null,
      { input: { scope: 'global', scopeKey: '', key: 'approval_threshold', value: '7' } },
      authCtx(PLAIN_USER),
    );
    expect(result).toMatchObject({ key: 'approval_threshold', value: '7' });
  });

  it('hides gym settings from a non-admin reader but shows them to an admin', async () => {
    await setAutoApprove(true);
    await socialCommunitySettingsMutations.setCommunitySettings(
      null,
      { input: { scope: 'global', scopeKey: '', key: 'approval_threshold', value: '7' } },
      authCtx(GLOBAL_ADMIN),
    );

    const asPlainUser = await socialCommunitySettingsQueries.communitySettings(
      null,
      { scope: 'global', scopeKey: '' },
      authCtx(PLAIN_USER),
    );
    expect(asPlainUser.map((setting) => setting.key)).toEqual(['approval_threshold']);

    const asAdmin = await socialCommunitySettingsQueries.communitySettings(
      null,
      { scope: 'global', scopeKey: '' },
      authCtx(GLOBAL_ADMIN),
    );
    expect(asAdmin.map((setting) => setting.key).sort()).toEqual(['approval_threshold', 'gym_claim_auto_approve']);
  });
});

// ============================================================================
// #4525 — a claim the gym's ownership has already moved past
// ============================================================================

/**
 * `applyGymClaim` used to decide purely from the claim row and the gym's CURRENT
 * state, so a claim that had been sitting in the queue could still be approved
 * long after someone settled the question a different way. Approving it moved
 * `owner_id` back to the claimant, demoted the admin's chosen owner to a gym
 * admin membership row, mailed that person "someone verified they manage this
 * gym" (which is false for a handover), and re-stamped `syncFrozenAt` — the one
 * write `reassignGymOwner` deliberately leaves out (#4520).
 *
 * These pin the refusal end to end: nothing at all is written, and the claim is
 * left `pending` so the claimant still gets a real outcome from Deny.
 */
describe('a claim ownership has moved past cannot be approved (#4525)', () => {
  // A gym reassigned in one test would otherwise still count as "moved" in the
  // next: gym_owner_reassignments has no FK to gyms, so the CASCADE that clears
  // the rest of the fixture leaves it alone (it's in the TRUNCATE list above for
  // exactly that reason). The reassign mutation is also capped at 10 per user,
  // and the tier-1 bucket does not reset by itself between tests.
  beforeEach(() => {
    resetAllRateLimits();
  });

  const REASSIGN_REASON = 'The wall was sold and the buyer runs it now.';

  const reassignTo = (gymUuid: string, currentOwnerId: string, newOwnerId: string) =>
    socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid,
          expectedCurrentOwnerId: currentOwnerId,
          newOwnerId,
          reason: REASSIGN_REASON,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

  const approveAsAdmin = (claimId: number) =>
    socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'approve' } }, authCtx(GLOBAL_ADMIN));

  const allMembers = async (gymId: number): Promise<Array<{ user_id: string; role: string }>> => {
    const result = await db.execute(sql`
      SELECT user_id, role FROM gym_members WHERE gym_id = ${gymId} ORDER BY user_id
    `);
    return Array.from(result as Iterable<{ user_id: string; role: string }>);
  };

  it('refuses the approval after a handover, and writes nothing at all', async () => {
    // The gym is deliberately UNFROZEN: a re-stamp here would stop location sync
    // maintaining a listing an admin had just decided sync may keep maintaining.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Superseded Wall' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await reassignTo(claimGym.uuid, PRIOR_OWNER, SECOND_TARGET);
    expect(await gymOwnerId(claimGym.uuid)).toBe(SECOND_TARGET);
    expect(await gymSyncFrozenAt(claimGym.uuid)).toBeNull();
    const membersAfterHandover = await allMembers(claimGym.id);
    vi.clearAllMocks();

    const rejection = await approveAsAdmin(claimId).catch((error: unknown) => error);
    expect((rejection as GraphQLError).extensions).toMatchObject({ code: GYM_CLAIM_SUPERSEDED_CODE });

    // Ownership stays where the admin put it, and the freeze marker is untouched.
    expect(await gymOwnerId(claimGym.uuid)).toBe(SECOND_TARGET);
    expect(await gymSyncFrozenAt(claimGym.uuid)).toBeNull();

    // The admin's chosen owner is NOT demoted to a membership row, and the
    // claimant's own rows are left exactly as they were.
    expect(await allMembers(claimGym.id)).toEqual(membersAfterHandover);

    // Still pending: Deny is how the claimant gets an outcome, and a denial
    // email that says so beats being closed out with nothing.
    expect(await claimStatus(claimId)).toBe('pending');

    // Nobody is told anything — least of all the "someone verified they manage
    // this gym" note to an owner who is still the owner.
    expect(await claimApprovedNotifications(CLAIMANT)).toEqual([]);
    expect(sendGymClaimApprovedEmail).not.toHaveBeenCalled();
    expect(sendGymClaimOwnershipLostEmail).not.toHaveBeenCalled();
  });

  it('leaves a frozen listing frozen at the exact same timestamp', async () => {
    // The unfrozen case above goes red on "set it anyway"; this one goes red on
    // a re-stamp that merely keeps the column non-null. Same split as #4520's
    // freeze-preservation pair.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Frozen Wall' });
    const frozenAt = '2026-08-01T01:02:03.000Z';
    await db.execute(sql`UPDATE gyms SET sync_frozen_at = ${frozenAt} WHERE id = ${claimGym.id}`);
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await reassignTo(claimGym.uuid, PRIOR_OWNER, SECOND_TARGET);

    const rejection = await approveAsAdmin(claimId).catch((error: unknown) => error);
    expect((rejection as GraphQLError).extensions).toMatchObject({ code: GYM_CLAIM_SUPERSEDED_CODE });

    const stillFrozenAt = await gymSyncFrozenAt(claimGym.uuid);
    expect(new Date(stillFrozenAt!).toISOString()).toBe(frozenAt);
    expect(await gymOwnerId(claimGym.uuid)).toBe(SECOND_TARGET);
  });

  it('refuses the second of two queued claims on one gym, with no handover involved', async () => {
    // The two-admin case the issue calls out: nothing but the claim queue is in
    // play, and the second approval would take the gym straight back off the
    // person the first one just gave it to.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Two Reviewers' });
    const firstClaim = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });
    const secondClaim = await insertClaim({ gymId: claimGym.id, claimantUserId: PLAIN_USER, method: 'admin' });

    await expect(approveAsAdmin(firstClaim)).resolves.toBe(true);
    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);

    const rejection = await approveAsAdmin(secondClaim).catch((error: unknown) => error);
    expect((rejection as GraphQLError).extensions).toMatchObject({ code: GYM_CLAIM_SUPERSEDED_CODE });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    expect(await claimStatus(secondClaim)).toBe('pending');
  });

  it('still approves a claim filed AFTER the handover', async () => {
    // The control. Without it the guard could refuse every approval and every
    // assertion above would still pass.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Claimed After Handover' });

    await reassignTo(claimGym.uuid, PRIOR_OWNER, SECOND_TARGET);
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(approveAsAdmin(claimId)).resolves.toBe(true);
    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    expect(await gymSyncFrozenAt(claimGym.uuid)).not.toBeNull();
    expect(await claimStatus(claimId)).toBe('approved');
    // The handover's owner is displaced by a decision made after it, which is
    // the normal claim path — so he keeps gym-admin access, as always.
    expect(await gymMemberRole(claimGym.id, SECOND_TARGET)).toBe('admin');
  });

  it('still approves when the handover gave the gym to the claimant themselves', async () => {
    // An admin who resolves a claim with the handover panel instead of the queue
    // leaves the row behind. Approving it moves nothing and freezes nothing —
    // it just closes the queue entry for the person who did get the gym. Refuse
    // that and Deny (with its "sorry, no" email) is their only way out.
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Handed To The Claimant' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await reassignTo(claimGym.uuid, PRIOR_OWNER, CLAIMANT);
    expect(await gymSyncFrozenAt(claimGym.uuid)).toBeNull();

    await expect(approveAsAdmin(claimId)).resolves.toBe(true);
    expect(await claimStatus(claimId)).toBe('approved');
    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // No transfer ran, so the freeze marker stays as the handover left it.
    expect(await gymSyncFrozenAt(claimGym.uuid)).toBeNull();
  });

  it('refuses the domain verification link too, and keeps the claim usable', async () => {
    // The emailed link is a second, unattended way into the same transfer. It
    // reports `superseded` rather than `used` — the link was never spent.
    const claimGym = await insertGym({
      ownerId: PRIOR_OWNER,
      name: 'Domain Superseded',
      website: 'https://www.domain-superseded.com',
    });
    const claimId = await insertClaim({
      gymId: claimGym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      claimEmail: 'boss@domain-superseded.com',
      tokenHash: hashClaimToken('superseded-token'),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await reassignTo(claimGym.uuid, PRIOR_OWNER, SECOND_TARGET);
    vi.clearAllMocks();

    expect(await verifyGymClaimByToken('superseded-token')).toEqual({ ok: false, reason: 'superseded' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(SECOND_TARGET);
    expect(await gymSyncFrozenAt(claimGym.uuid)).toBeNull();
    expect(await claimStatus(claimId)).toBe('pending');
    expect(sendGymClaimApprovedEmail).not.toHaveBeenCalled();
    expect(sendGymClaimOwnershipLostEmail).not.toHaveBeenCalled();
  });
});
