import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql, eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { socialGymQueries, socialGymMutations } from '../graphql/resolvers/social/gyms';
import {
  socialGymClaimMutations,
  socialGymClaimQueries,
  applyGymClaim,
  verifyGymClaimByToken,
  hashClaimToken,
} from '../graphql/resolvers/social/gym-claims';

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
  sendGymClaimOwnershipLostEmail: vi.fn(() => Promise.resolve()),
}));
import {
  sendGymClaimVerificationEmail,
  sendGymClaimAdminNotification,
  sendGymClaimApprovedEmail,
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
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, uuid = uuidv4(), website = null, isPublic = true } = opts;
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, website, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${website}, ${isPublic}, now(), now())
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

const gymOwnerId = async (gymUuid: string): Promise<string> => {
  const result = await db.execute(sql`SELECT owner_id FROM gyms WHERE uuid = ${gymUuid} LIMIT 1`);
  return Array.from(result as Iterable<{ owner_id: string }>)[0].owner_id;
};

const claimStatus = async (claimId: number): Promise<string> => {
  const result = await db.execute(sql`SELECT status FROM gym_claims WHERE id = ${claimId} LIMIT 1`);
  return Array.from(result as Iterable<{ status: string }>)[0].status;
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
      "community_roles", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms"
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
    expect(applied).toEqual({ gymName: 'Real Gym', claimEmail: 'boss@realgym.com', priorOwnerId: PRIOR_OWNER });

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
    expect(result).toEqual({ ok: true, gymName: 'Catalog Gym' });

    expect(await gymOwnerId(claimGym.uuid)).toBe(CLAIMANT);
    // System placeholder owner is NOT retained as a member.
    expect(await gymMemberRole(claimGym.id, SYSTEM_OWNER)).toBeNull();
    expect(await claimStatus(claimId)).toBe('approved');
    // Best-effort approval email fired (claimEmail present).
    expect(sendGymClaimApprovedEmail).toHaveBeenCalledWith('owner@catalog-gym.com', 'Catalog Gym');
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
  });

  it('admin deny marks the claim denied without transferring', async () => {
    const claimGym = await insertGym({ ownerId: PRIOR_OWNER, name: 'Deny Gym' });
    const claimId = await insertClaim({ gymId: claimGym.id, claimantUserId: CLAIMANT, method: 'admin' });

    await expect(
      socialGymClaimMutations.reviewGymClaim(null, { input: { claimId, decision: 'deny' } }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);

    expect(await gymOwnerId(claimGym.uuid)).toBe(PRIOR_OWNER);
    expect(await claimStatus(claimId)).toBe('denied');
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
    expect(applied).toEqual({ ok: true, gymName: 'Retoken Gym' });
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
