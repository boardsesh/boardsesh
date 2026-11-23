import { describe, it, expect, beforeEach, afterAll, vi } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import type { GraphQLError } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, DirectoryNotice, UserBoard } from '@boardsesh/shared-schema';
import { upsertPublicBoardLocations, type PublicBoardLocationInput } from '@boardsesh/location-sync';

vi.mock('../email/email-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/email-service')>()),
  sendGymClaimVerificationEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimAdminNotification: vi.fn(() => Promise.resolve()),
  sendGymClaimApprovedEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimDeniedEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimExpiredEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimRevokedEmail: vi.fn(() => Promise.resolve()),
  sendGymClaimOwnershipLostEmail: vi.fn(() => Promise.resolve()),
  sendAdminDailyDigestEmail: vi.fn(() => Promise.resolve()),
}));

import { db } from '../db/client';
import {
  sendGymClaimAdminNotification,
  sendGymClaimExpiredEmail,
  sendGymClaimRevokedEmail,
} from '../email/email-service';
import {
  applyGymClaim,
  expireStaleAdminClaims,
  GYM_CLAIM_EXPIRY_STARTS_AT,
  hashClaimToken,
  socialGymClaimMutations,
  socialGymClaimQueries,
  tryAutoApproveAdminClaim,
} from '../graphql/resolvers/social/gym-claims';
import {
  firstFailedAutoApproveGuard,
  GYM_CLAIM_PROBATION_CODE,
  GYM_CLAIM_PROBATION_DAYS,
} from '../graphql/resolvers/social/gym-claim-guardrails';
import { GYM_CLAIM_REVERT_CODES, socialGymClaimRevertMutations } from '../graphql/resolvers/social/gym-claim-revert';
import { socialGymMutations, enrichGym } from '../graphql/resolvers/social/gyms';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { socialGymOwnerReassignMutations } from '../graphql/resolvers/social/gym-owner-reassign';
import { enrichDirectoryNotices } from '../graphql/resolvers/social/directory-reports/notices';
import { autoApprovedClaimsSection, runDirectoryReportSweep } from '../services/directory-report-sweep';
import { __resetDirectoryReportsFlagForTests } from '../services/directory-reports-flag';
import { handleGymClaimVerify } from '../handlers/gym-claims';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Claim guardrails (docs/product/gym-claims.md): the five auto-approval guards
 * and the lock that keeps them true under concurrency, the 14-day probation,
 * revertGymClaim, the auto-approval digest section, the 30-day expiry of
 * admin-review claims, the claim notices, the review queue's claimant history
 * and the verify link's error redirect.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CLAIMANT = 'cg-claimant';
const OTHER_CLAIMANT = 'cg-other-claimant';
const NEW_ACCOUNT = 'cg-new-account';
const CREATOR = 'cg-creator';
const SECOND_CREATOR = 'cg-second-creator';
const PRIVATE_CREATOR = 'cg-private-creator';
const SECOND_ADMIN = 'cg-second-admin';
const LATE_EDITOR = 'cg-late-editor';
const LATE_MEMBER = 'cg-late-member';
const GLOBAL_ADMIN = 'cg-global-admin';
const OLD_ACCOUNTS = [
  CLAIMANT,
  OTHER_CLAIMANT,
  CREATOR,
  SECOND_CREATOR,
  PRIVATE_CREATOR,
  SECOND_ADMIN,
  LATE_EDITOR,
  LATE_MEMBER,
  GLOBAL_ADMIN,
];

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = { latitude: 46.5, longitude: 7.5 };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const savedOverrides = process.env.FEATURE_FLAG_OVERRIDES;
function setFlag(on: boolean) {
  process.env.FEATURE_FLAG_OVERRIDES = on ? 'directory-reports' : 'directory-reports=false';
  __resetDirectoryReportsFlagForTests();
}

async function setSetting(key: string, value: string) {
  await db
    .insert(dbSchema.communitySettings)
    .values({ scope: 'global', scopeKey: '', key, value })
    .onConflictDoUpdate({
      target: [dbSchema.communitySettings.scope, dbSchema.communitySettings.scopeKey, dbSchema.communitySettings.key],
      set: { value },
    });
}

async function insertUser(id: string, ageDays: number) {
  await db
    .insert(dbSchema.users)
    .values({ id, email: `${id}@test.com`, name: `User ${id}`, createdAt: new Date(Date.now() - ageDays * DAY_MS) })
    .onConflictDoNothing();
}

type GymRow = typeof dbSchema.gyms.$inferSelect;

async function insertGym(ownerId: string, name = 'Synced Gym'): Promise<GymRow> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: `gym-${uuid.slice(0, 8)}`, name, ownerId, isPublic: true, ...BASE })
    .returning();
  return gym;
}

let boardCounter = 0;
async function insertBoard(
  ownerId: string,
  gymId: number | null,
  overrides: { isPublic?: boolean; deleted?: boolean } = {},
): Promise<{ id: number; uuid: string; name: string }> {
  const uuid = uuidv4();
  const name = `Wall ${boardCounter}`;
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      name,
      ownerId,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 900 + boardCounter++,
      setIds: '1,2',
      gymId,
      isPublic: overrides.isPublic ?? true,
      angle: 40,
      ...BASE,
      deletedAt: overrides.deleted ? new Date() : null,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  return { ...board, name };
}

async function requestClaim(userId: string, gymUuid: string): Promise<string> {
  const result = (await socialGymClaimMutations.requestGymClaim(
    null,
    { input: { gymUuid, message: 'I run this gym' } },
    authCtx(userId),
  )) as { status: string };
  return result.status;
}

async function claimFor(gymId: number, claimantUserId: string) {
  const [claim] = await db
    .select()
    .from(dbSchema.gymClaims)
    .where(and(eq(dbSchema.gymClaims.gymId, gymId), eq(dbSchema.gymClaims.claimantUserId, claimantUserId)));
  return claim;
}

/** A pending claim filed `filed` days ago, or at that exact time. */
async function insertPendingClaim(gymId: number, claimantUserId: string, filed: number | Date = 0, method = 'admin') {
  const [claim] = await db
    .insert(dbSchema.gymClaims)
    .values({
      gymId,
      claimantUserId,
      method: method as 'admin' | 'domain',
      status: 'pending',
      createdAt: filed instanceof Date ? filed : new Date(Date.now() - filed * DAY_MS),
    })
    .returning();
  return claim;
}

async function gymRow(gymId: number): Promise<GymRow> {
  const [gym] = await db.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gymId));
  return gym;
}

async function memberIds(gymId: number): Promise<string[]> {
  const rows = await db
    .select({ userId: dbSchema.gymMembers.userId })
    .from(dbSchema.gymMembers)
    .where(eq(dbSchema.gymMembers.gymId, gymId));
  return rows.map((row) => row.userId).sort();
}

async function noticesFor(recipientId: string, type: (typeof dbSchema.notifications.$inferSelect)['type']) {
  return db
    .select({
      uuid: dbSchema.notifications.uuid,
      type: dbSchema.notifications.type,
      actorId: dbSchema.notifications.actorId,
      entityType: dbSchema.notifications.entityType,
      entityId: dbSchema.notifications.entityId,
      boardId: dbSchema.directoryNotificationContext.boardId,
    })
    .from(dbSchema.notifications)
    .leftJoin(
      dbSchema.directoryNotificationContext,
      eq(dbSchema.directoryNotificationContext.notificationUuid, dbSchema.notifications.uuid),
    )
    .where(and(eq(dbSchema.notifications.recipientId, recipientId), eq(dbSchema.notifications.type, type)));
}

/** Move the gym's auto-approval back in time, as if it happened `daysAgo` days ago. */
async function ageApproval(claimId: number, daysAgo: number) {
  await db
    .update(dbSchema.gymClaimOwnershipDecisions)
    .set({ decidedAt: new Date(Date.now() - daysAgo * DAY_MS) })
    .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, claimId));
}

function graphQLCode(error: unknown): unknown {
  return (error as GraphQLError).extensions?.code;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<GraphQLError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected a ${code} refusal`).not.toBeNull();
  expect(graphQLCode(error)).toBe(code);
  return error as GraphQLError;
}

beforeEach(async () => {
  resetAllRateLimits();
  setFlag(true);
  vi.clearAllMocks();
  await db.execute(sql`
    TRUNCATE TABLE
      "directory_notification_context", "directory_report_reporters", "directory_reports", "admin_daily_digests",
      "notifications", "resource_privacy", "resource_grants", "community_roles", "community_settings",
      "gym_members", "gym_follows", "gym_claims", "gym_owner_reassignments", "location_sync_gym_sources",
      "board_moderation_events", "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await insertUser(SYSTEM_OWNER, 400);
  await Promise.all(OLD_ACCOUNTS.map((id) => insertUser(id, 60)));
  await insertUser(NEW_ACCOUNT, 2);
  await db.insert(dbSchema.communityRoles).values({ userId: GLOBAL_ADMIN, role: 'admin', boardType: null });
  await setSetting('gym_claim_auto_approve', '1');
});

afterAll(() => {
  if (savedOverrides === undefined) delete process.env.FEATURE_FLAG_OVERRIDES;
  else process.env.FEATURE_FLAG_OVERRIDES = savedOverrides;
  __resetDirectoryReportsFlagForTests();
});

/** An auto-approved claim on a fresh synced gym, with a synced board on it. */
async function autoApprovedGym(claimantUserId = CLAIMANT, name = 'Synced Gym') {
  const gym = await insertGym(SYSTEM_OWNER, name);
  const systemBoard = await insertBoard(SYSTEM_OWNER, gym.id);
  expect(await requestClaim(claimantUserId, gym.uuid)).toBe('approved');
  const claim = await claimFor(gym.id, claimantUserId);
  return { gym, systemBoard, claim };
}

// ============================================================================
// Guards
// ============================================================================

describe('auto-approval guards', () => {
  it('approves a claim that passes every guard, and the claimant owns the gym', async () => {
    const { gym, claim } = await autoApprovedGym();
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
    expect(claim).toMatchObject({ method: 'admin', status: 'approved', reviewedBy: null });
    expect(sendGymClaimAdminNotification).not.toHaveBeenCalled();
  });

  it('queues a second claim from an account that already had one approve itself, even once reverted', async () => {
    const { claim } = await autoApprovedGym();
    const second = await insertGym(SYSTEM_OWNER, 'Second Gym');
    expect(await requestClaim(CLAIMANT, second.uuid)).toBe('admin_review');
    const queued = await claimFor(second.id, CLAIMANT);
    expect(queued.status).toBe('pending');
    expect(await firstFailedAutoApproveGuard(db, queued)).toBe('already_auto_approved');
    expect(sendGymClaimAdminNotification).toHaveBeenCalledTimes(1);

    await socialGymClaimRevertMutations.revertGymClaim(
      null,
      { input: { claimId: String(claim.id) } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(await firstFailedAutoApproveGuard(db, queued)).toBe('already_auto_approved');
  });

  it('queues a claim from an account younger than 30 days', async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    expect(await requestClaim(NEW_ACCOUNT, gym.uuid)).toBe('admin_review');
    const claim = await claimFor(gym.id, NEW_ACCOUNT);
    expect(await firstFailedAutoApproveGuard(db, claim)).toBe('account_too_new');
    expect((await gymRow(gym.id)).ownerId).toBe(SYSTEM_OWNER);

    // 31 days old is old enough.
    await db
      .update(dbSchema.users)
      .set({ createdAt: new Date(Date.now() - 31 * DAY_MS) })
      .where(eq(dbSchema.users.id, NEW_ACCOUNT));
    expect(await firstFailedAutoApproveGuard(db, claim)).toBeNull();
  });

  it("queues a claim on a gym with another climber's live board, and ignores the rest", async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    await insertBoard(SYSTEM_OWNER, gym.id);
    await insertBoard(CLAIMANT, gym.id);
    await insertBoard(CREATOR, gym.id, { deleted: true });
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    // Synced boards, the claimant's own board and a deleted board don't count.
    expect(await firstFailedAutoApproveGuard(db, claim)).toBeNull();

    await insertBoard(CREATOR, gym.id);
    expect(await firstFailedAutoApproveGuard(db, claim)).toBe('climber_boards_linked');
    const result = await tryAutoApproveAdminClaim(authCtx(CLAIMANT), gym, claim);
    expect(result).toEqual({ applied: null, stoppedBy: 'climber_boards_linked' });
    expect((await claimFor(gym.id, CLAIMANT)).status).toBe('pending');
  });

  it('queues a claim on a gym with an admin or editor, the claimant included, and checks again under the lock', async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: LATE_MEMBER, role: 'member' });
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    // A plain member runs nothing.
    expect(await firstFailedAutoApproveGuard(db, claim)).toBeNull();

    for (const [userId, role] of [
      [SECOND_ADMIN, 'admin'],
      [LATE_EDITOR, 'editor'],
      [CLAIMANT, 'editor'],
    ] as const) {
      await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId, role });
      expect(await firstFailedAutoApproveGuard(db, claim)).toBe('gym_has_staff');
      await db
        .delete(dbSchema.gymMembers)
        .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)));
    }

    // Staff that arrive after the first check still stop the apply.
    expect(await firstFailedAutoApproveGuard(db, claim)).toBeNull();
    await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: LATE_EDITOR, role: 'editor' });
    expect(await applyGymClaim(claim, { requireCurrentOwnerId: SYSTEM_OWNER, autoApprove: true })).toEqual({
      outcome: 'not_eligible',
      guard: 'gym_has_staff',
    });
    expect(await tryAutoApproveAdminClaim(authCtx(CLAIMANT), gym, claim)).toEqual({
      applied: null,
      stoppedBy: 'gym_has_staff',
    });
    expect((await gymRow(gym.id)).ownerId).toBe(SYSTEM_OWNER);
    expect((await claimFor(gym.id, CLAIMANT)).status).toBe('pending');
  });

  it('queues claims past the daily cap, counting only the last 24 hours', async () => {
    await setSetting('gym_claim_auto_approve_daily_cap', '1');
    const { claim: first } = await autoApprovedGym(OTHER_CLAIMANT);

    const gym = await insertGym(SYSTEM_OWNER, 'Over The Cap');
    expect(await requestClaim(CLAIMANT, gym.uuid)).toBe('admin_review');
    const queued = await claimFor(gym.id, CLAIMANT);
    expect(await firstFailedAutoApproveGuard(db, queued)).toBe('daily_cap_reached');

    await ageApproval(first.id, 1.1);
    expect(await firstFailedAutoApproveGuard(db, queued)).toBeNull();
  });

  it('reads a cap of 0 as "nothing approves itself", and a malformed one as the default', async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    await setSetting('gym_claim_auto_approve_daily_cap', '0');
    expect(await firstFailedAutoApproveGuard(db, claim)).toBe('daily_cap_reached');
    await setSetting('gym_claim_auto_approve_daily_cap', 'ten');
    expect(await firstFailedAutoApproveGuard(db, claim)).toBeNull();
  });

  it('lets only one of two concurrent claims past a cap of one: the guards run again under the lock', async () => {
    await setSetting('gym_claim_auto_approve_daily_cap', '1');
    const gymA = await insertGym(SYSTEM_OWNER, 'Race A');
    const gymB = await insertGym(SYSTEM_OWNER, 'Race B');
    const claimA = await insertPendingClaim(gymA.id, CLAIMANT);
    const claimB = await insertPendingClaim(gymB.id, OTHER_CLAIMANT);
    // Both pass the check before the lock, which is exactly the race.
    expect(await firstFailedAutoApproveGuard(db, claimA)).toBeNull();
    expect(await firstFailedAutoApproveGuard(db, claimB)).toBeNull();

    const outcomes = await Promise.all(
      [claimA, claimB].map((claim) => applyGymClaim(claim, { requireCurrentOwnerId: SYSTEM_OWNER, autoApprove: true })),
    );
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['applied', 'not_eligible']);
    expect(outcomes.find((outcome) => outcome.outcome === 'not_eligible')).toEqual({
      outcome: 'not_eligible',
      guard: 'daily_cap_reached',
    });
    const statuses = [(await claimFor(gymA.id, CLAIMANT)).status, (await claimFor(gymB.id, OTHER_CLAIMANT)).status];
    expect(statuses.sort()).toEqual(['approved', 'pending']);
  });

  it('says which stop left a claim queued: the rate limit after three tries', async () => {
    const claimant = `cg-rate-${uuidv4()}`;
    await insertUser(claimant, 60);
    // A gym someone owns never approves itself, so each try spends the limit.
    const owned = await insertGym(OTHER_CLAIMANT, 'Owned');
    const claim = await insertPendingClaim(owned.id, claimant);
    const stops = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      stops.push((await tryAutoApproveAdminClaim(authCtx(claimant), owned, claim)).stoppedBy);
    }
    expect(stops).toEqual(['not_unclaimed', 'not_unclaimed', 'not_unclaimed', 'rate_limited']);
  });

  it('does nothing while the setting is off', async () => {
    await setSetting('gym_claim_auto_approve', '0');
    const gym = await insertGym(SYSTEM_OWNER);
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    expect(await tryAutoApproveAdminClaim(authCtx(CLAIMANT), gym, claim)).toEqual({
      applied: null,
      stoppedBy: 'disabled',
    });
  });
});

// ============================================================================
// Probation
// ============================================================================

describe('probation after a claim approved itself', () => {
  let gym: GymRow;
  let systemBoard: { id: number; uuid: string };
  let claimId: number;

  beforeEach(async () => {
    const setup = await insertGym(SYSTEM_OWNER, 'Probation Gym');
    await db.insert(dbSchema.gymMembers).values({ gymId: setup.id, userId: LATE_MEMBER, role: 'member' });
    systemBoard = await insertBoard(SYSTEM_OWNER, setup.id);
    expect(await requestClaim(CLAIMANT, setup.uuid)).toBe('approved');
    gym = await gymRow(setup.id);
    claimId = (await claimFor(gym.id, CLAIMANT)).id;
    // A second admin (a gym with staff never approves itself, so they arrived
    // after the claim): probation binds them too.
    await db.insert(dbSchema.gymMembers).values({ gymId: setup.id, userId: SECOND_ADMIN, role: 'admin' });
  });

  it('refuses deleting the gym, with the date it opens', async () => {
    const error = await expectCode(
      socialGymMutations.deleteGym(null, { gymUuid: gym.uuid }, authCtx(CLAIMANT)),
      GYM_CLAIM_PROBATION_CODE,
    );
    const endsAt = new Date(String(error.extensions.endsAt));
    expect(Math.abs(endsAt.getTime() - (Date.now() + GYM_CLAIM_PROBATION_DAYS * DAY_MS))).toBeLessThan(60_000);
    const dateLabel = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(endsAt);
    expect(error.message).toContain(dateLabel);
    expect((await gymRow(gym.id)).deletedAt).toBeNull();
  });

  it('refuses adding an admin, but not a member', async () => {
    await expectCode(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid: gym.uuid, userId: OTHER_CLAIMANT, role: 'admin' } },
        authCtx(CLAIMANT),
      ),
      GYM_CLAIM_PROBATION_CODE,
    );
    await expect(
      socialGymMutations.addGymMember(
        null,
        { input: { gymUuid: gym.uuid, userId: OTHER_CLAIMANT, role: 'member' } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toBe(true);
  });

  it('refuses removing members, for the owner and for another admin', async () => {
    for (const actor of [CLAIMANT, SECOND_ADMIN]) {
      await expectCode(
        socialGymMutations.removeGymMember(null, { input: { gymUuid: gym.uuid, userId: LATE_MEMBER } }, authCtx(actor)),
        GYM_CLAIM_PROBATION_CODE,
      );
    }
    expect(await memberIds(gym.id)).toEqual([LATE_MEMBER, SECOND_ADMIN].sort());
  });

  it("refuses taking an editor's access away, but not granting it", async () => {
    await expect(
      socialGymMutations.grantGymWriteAccess(
        null,
        { input: { gymUuid: gym.uuid, userId: LATE_EDITOR } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toBe(true);
    for (const actor of [CLAIMANT, SECOND_ADMIN]) {
      await expectCode(
        socialGymMutations.revokeGymWriteAccess(
          null,
          { input: { gymUuid: gym.uuid, userId: LATE_EDITOR } },
          authCtx(actor),
        ),
        GYM_CLAIM_PROBATION_CODE,
      );
    }
    expect(await memberIds(gym.id)).toContain(LATE_EDITOR);
  });

  it("refuses deleting the gym's synced boards, and canDelete says so in both reads", async () => {
    for (const actor of [CLAIMANT, SECOND_ADMIN]) {
      await expectCode(
        socialBoardMutations.deleteBoard(null, { boardUuid: systemBoard.uuid }, authCtx(actor)),
        GYM_CLAIM_PROBATION_CODE,
      );
      const single = (await socialBoardQueries.board(
        null,
        { boardUuid: systemBoard.uuid },
        authCtx(actor),
      )) as UserBoard;
      expect(single.canDelete).toBe(false);
      const listed = (await socialBoardQueries.gymBoards(null, { gymUuid: gym.uuid }, authCtx(actor))) as UserBoard[];
      expect(listed.find((board) => board.uuid === systemBoard.uuid)?.canDelete).toBe(false);
    }
  });

  it('lets a global admin through', async () => {
    const listed = (await socialBoardQueries.gymBoards(
      null,
      { gymUuid: gym.uuid },
      authCtx(GLOBAL_ADMIN),
    )) as UserBoard[];
    expect(listed.find((board) => board.uuid === systemBoard.uuid)?.canDelete).toBe(true);
    // A global admin who is also a gym admin is still exempt.
    await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: GLOBAL_ADMIN, role: 'admin' });
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: systemBoard.uuid }, authCtx(GLOBAL_ADMIN)),
    ).resolves.toBe(true);
  });

  it('lifts after 14 days', async () => {
    await ageApproval(claimId, GYM_CLAIM_PROBATION_DAYS + 0.1);
    const single = (await socialBoardQueries.board(
      null,
      { boardUuid: systemBoard.uuid },
      authCtx(SECOND_ADMIN),
    )) as UserBoard;
    expect(single.canDelete).toBe(true);
    await expect(
      socialGymMutations.removeGymMember(
        null,
        { input: { gymUuid: gym.uuid, userId: LATE_MEMBER } },
        authCtx(CLAIMANT),
      ),
    ).resolves.toBe(true);
    await expect(socialGymMutations.deleteGym(null, { gymUuid: gym.uuid }, authCtx(CLAIMANT))).resolves.toBe(true);
  });

  it('does not apply after a claim an admin approved', async () => {
    await setSetting('gym_claim_auto_approve', '0');
    const reviewedGym = await insertGym(SYSTEM_OWNER, 'Reviewed Gym');
    const board = await insertBoard(SYSTEM_OWNER, reviewedGym.id);
    expect(await requestClaim(OTHER_CLAIMANT, reviewedGym.uuid)).toBe('admin_review');
    const claim = await claimFor(reviewedGym.id, OTHER_CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(claim.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );
    await expect(
      socialBoardMutations.deleteBoard(null, { boardUuid: board.uuid }, authCtx(OTHER_CLAIMANT)),
    ).resolves.toBe(true);
  });
});

// ============================================================================
// Revert
// ============================================================================

describe('revertGymClaim', () => {
  const revert = (claimId: number, userId = GLOBAL_ADMIN, reason?: string) =>
    socialGymClaimRevertMutations.revertGymClaim(
      null,
      { input: { claimId: String(claimId), reason } },
      authCtx(userId),
    );

  it('hands the gym back to SYSTEM and undoes what the claimant set up', async () => {
    const gym = await insertGym(SYSTEM_OWNER, 'Upstream Name');
    // An admin from before the claim: the gym has staff, so a person approves it.
    await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: SECOND_ADMIN, role: 'admin' });
    expect(await requestClaim(CLAIMANT, gym.uuid)).toBe('admin_review');
    const claim = await claimFor(gym.id, CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(claim.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );

    // The claimant renames it (vouching a website) and brings people in.
    await socialGymMutations.updateGym(
      null,
      { input: { gymUuid: gym.uuid, name: 'Prank Name', website: 'https://prank.example.com' } },
      authCtx(CLAIMANT),
    );
    await socialGymMutations.grantGymWriteAccess(
      null,
      { input: { gymUuid: gym.uuid, userId: LATE_EDITOR } },
      authCtx(CLAIMANT),
    );
    await socialGymMutations.addGymMember(
      null,
      { input: { gymUuid: gym.uuid, userId: LATE_MEMBER, role: 'member' } },
      authCtx(CLAIMANT),
    );
    const before = await gymRow(gym.id);
    expect(before).toMatchObject({ ownerId: CLAIMANT, websiteVouchedByOwner: true });
    expect(before.syncFrozenAt).not.toBeNull();

    const result = await revert(claim.id, GLOBAL_ADMIN, 'Not the gym');
    expect(result).toEqual({
      claimId: String(claim.id),
      gymUuid: gym.uuid,
      gymName: 'Prank Name',
      removedMemberCount: 2,
    });

    const after = await gymRow(gym.id);
    expect(after).toMatchObject({ ownerId: SYSTEM_OWNER, syncFrozenAt: null, websiteVouchedByOwner: false });
    expect(await claimFor(gym.id, CLAIMANT)).toMatchObject({ status: 'revoked', reviewedBy: GLOBAL_ADMIN });
    // The admin from before the claim stays; everyone the claimant added goes.
    expect(await memberIds(gym.id)).toEqual([SECOND_ADMIN]);

    const [audit] = await db.select().from(dbSchema.gymOwnerReassignments);
    expect(audit).toMatchObject({
      gymUuid: gym.uuid,
      previousOwnerId: CLAIMANT,
      newOwnerId: SYSTEM_OWNER,
      syncFrozenAtAfter: null,
      performedBy: GLOBAL_ADMIN,
      reason: `Claim ${claim.id} reverted: Not the gym`,
    });
    expect(audit.syncFrozenAtBefore).not.toBeNull();

    expect((await enrichGym(after, OTHER_CLAIMANT)).listingState).toBe('UNCLAIMED');
    expect(await noticesFor(CLAIMANT, 'gym_claim_denied')).toEqual([
      expect.objectContaining({ actorId: null, entityType: 'gym', entityId: gym.uuid }),
    ]);
    await vi.waitFor(() => expect(sendGymClaimRevokedEmail).toHaveBeenCalledWith(`${CLAIMANT}@test.com`, 'Prank Name'));
  });

  it('lets the location sync curate the gym again, revoking an older approved claim too', async () => {
    const gym = await insertGym(SYSTEM_OWNER, 'Upstream Name');
    const sourceKey = `kilter:gym-${gym.uuid}`;
    await db.insert(dbSchema.locationSyncGymSources).values({ sourceKey, gymId: gym.id });
    // An approved claim from long ago that no longer owns anything. The sync
    // reads any approved claim on a gym as owner-curated.
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    const [older] = await db
      .insert(dbSchema.gymClaims)
      .values({
        gymId: gym.id,
        claimantUserId: OTHER_CLAIMANT,
        method: 'admin',
        status: 'approved',
        reviewedBy: GLOBAL_ADMIN,
        createdAt: tenDaysAgo,
        updatedAt: tenDaysAgo,
      })
      .returning();
    expect(await requestClaim(CLAIMANT, gym.uuid)).toBe('approved');
    const claim = await claimFor(gym.id, CLAIMANT);
    await socialGymMutations.updateGym(null, { input: { gymUuid: gym.uuid, name: 'Prank Name' } }, authCtx(CLAIMANT));

    const record = (boardSuffix: string): PublicBoardLocationInput => ({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
      isAngleAdjustable: true,
      sourceKey: `kilter:board-${gym.uuid}-${boardSuffix}`,
      gymSourceKey: sourceKey,
      name: 'Upstream Board',
      slugBase: `Upstream Board ${boardSuffix}`,
      locationName: null,
      ...BASE,
      gymName: 'Upstream Name',
      gymAddress: null,
    });

    // Claimed: the sync links its board to the gym and leaves the name alone.
    await upsertPublicBoardLocations(db, [record('a')]);
    expect((await gymRow(gym.id)).name).toBe('Prank Name');

    await revert(claim.id);
    expect((await claimFor(gym.id, OTHER_CLAIMANT)).id).toBe(older.id);
    expect((await claimFor(gym.id, OTHER_CLAIMANT)).status).toBe('revoked');
    await upsertPublicBoardLocations(db, [record('b')]);
    expect((await gymRow(gym.id)).name).toBe('Upstream Name');
  });

  it('is for global admins only', async () => {
    const { claim } = await autoApprovedGym();
    await expect(revert(claim.id, CLAIMANT)).rejects.toThrow(/Admin role required/);
    expect((await claimFor(claim.gymId, CLAIMANT)).status).toBe('approved');
  });

  it('refuses a claim that is not approved', async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.notApproved);
    await expectCode(revert(999_999), GYM_CLAIM_REVERT_CODES.notFound);
  });

  it('refuses once the gym has changed hands since the claim', async () => {
    const { gym, claim } = await autoApprovedGym();
    await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: CLAIMANT,
          newOwnerId: OTHER_CLAIMANT,
          reason: 'Sold to the new owner',
        },
      },
      authCtx(GLOBAL_ADMIN),
    );
    await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.ownerChanged);
    expect((await gymRow(gym.id)).ownerId).toBe(OTHER_CLAIMANT);
  });

  it('refuses once the gym was moved after the claim, even back to the claimant', async () => {
    const { gym, claim } = await autoApprovedGym();
    for (const [from, to] of [
      [CLAIMANT, OTHER_CLAIMANT],
      [OTHER_CLAIMANT, CLAIMANT],
    ]) {
      await socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: { gymUuid: gym.uuid, expectedCurrentOwnerId: from, newOwnerId: to, reason: 'Handed over at the desk' },
        },
        authCtx(GLOBAL_ADMIN),
      );
    }
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
    await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.ownerChanged);
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
    expect((await claimFor(gym.id, CLAIMANT)).status).toBe('approved');
  });

  it('refuses after a later ownership decision, and a claim that moved nothing', async () => {
    const { gym, claim } = await autoApprovedGym();
    // A second claim by the owner, approved later: it moves nothing, but it is
    // a later decision on the gym.
    const second = await insertPendingClaim(gym.id, CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(second.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );
    await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.ownerChanged);
    await expectCode(revert(second.id), GYM_CLAIM_REVERT_CODES.notTransferred);
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
  });

  it('refuses a claim with no record of moving the gym', async () => {
    const { gym, claim } = await autoApprovedGym();
    await db
      .delete(dbSchema.gymClaimOwnershipDecisions)
      .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, claim.id));
    await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.notTransferred);
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
  });

  it('refuses a claim that took the gym from a person, and one with no record of the owner before', async () => {
    const gym = await insertGym(CREATOR, 'Climber Listed');
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(claim.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );
    const error = await expectCode(revert(claim.id), GYM_CLAIM_REVERT_CODES.priorOwner);
    expect(error.message).toContain('Move gym ownership');
    expect((await gymRow(gym.id)).ownerId).toBe(CLAIMANT);
    expect(await memberIds(gym.id)).toEqual([CREATOR]);
    expect((await claimFor(gym.id, CLAIMANT)).status).toBe('approved');

    // A decision row from before the owner was recorded reads as unknown.
    const { gym: synced, claim: autoClaim } = await autoApprovedGym(OTHER_CLAIMANT, 'Unrecorded');
    await db
      .update(dbSchema.gymClaimOwnershipDecisions)
      .set({ previousOwnerId: null })
      .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, autoClaim.id));
    await expectCode(revert(autoClaim.id), GYM_CLAIM_REVERT_CODES.priorOwner);
    expect((await gymRow(synced.id)).ownerId).toBe(OTHER_CLAIMANT);
  });

  it('still reverts when the in-app notice cannot be written', async () => {
    const { gym, claim } = await autoApprovedGym();
    await db.execute(sql`DROP TRIGGER IF EXISTS trg_test_reject_revert_notice ON notifications`);
    await db.execute(sql`DROP FUNCTION IF EXISTS test_reject_revert_notice()`);
    await db.execute(sql`
      CREATE FUNCTION test_reject_revert_notice() RETURNS trigger
      LANGUAGE plpgsql AS $reject$
      BEGIN
        RAISE EXCEPTION 'forced notice write failure';
      END;
      $reject$
    `);
    await db.execute(sql`
      CREATE TRIGGER trg_test_reject_revert_notice
      BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION test_reject_revert_notice()
    `);
    try {
      await expect(revert(claim.id)).resolves.toMatchObject({ claimId: String(claim.id) });
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS trg_test_reject_revert_notice ON notifications`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_reject_revert_notice()`);
    }
    expect((await gymRow(gym.id)).ownerId).toBe(SYSTEM_OWNER);
    expect((await claimFor(gym.id, CLAIMANT)).status).toBe('revoked');
    expect(await noticesFor(CLAIMANT, 'gym_claim_denied')).toEqual([]);
  });

  it("waits for the gym's lock before adding a member, so a revert can't miss one", async () => {
    const { gym } = await autoApprovedGym();
    // Stand in for a revert: hold the gym row lock, then hand the gym to SYSTEM.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gym.id)).for('update');
      lockTaken();
      await released;
      await tx.update(dbSchema.gyms).set({ ownerId: SYSTEM_OWNER }).where(eq(dbSchema.gyms.id, gym.id));
    });
    await locked;

    // The claimant passes the gate before the "revert" commits.
    const adding = socialGymMutations
      .addGymMember(null, { input: { gymUuid: gym.uuid, userId: LATE_MEMBER, role: 'member' } }, authCtx(CLAIMANT))
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await vi.waitFor(async () => {
        const result = await db.execute(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
        `);
        expect(Array.from(result as Iterable<{ waiting: number }>)[0].waiting).toBeGreaterThan(0);
      });
    } finally {
      release();
      await holder;
    }

    expect(await adding).toEqual(expect.objectContaining({ message: 'Not authorized: must be gym owner or admin' }));
    expect(await memberIds(gym.id)).toEqual([]);
  });

  it('refuses a delete when the revert commits between its owner check and the delete', async () => {
    const { gym, systemBoard, claim } = await autoApprovedGym();
    // Past probation, so the claimant may delete the gym they own.
    await ageApproval(claim.id, GYM_CLAIM_PROBATION_DAYS + 0.1);

    // deleteGym has read the gym and found the claimant its owner; the revert
    // commits just before its write's transaction opens.
    const realTransaction = db.transaction.bind(db);
    const revertFirst = vi.spyOn(db, 'transaction').mockImplementationOnce(async (work, config) => {
      await revert(claim.id);
      return realTransaction(work, config);
    });
    try {
      await expect(socialGymMutations.deleteGym(null, { gymUuid: gym.uuid }, authCtx(CLAIMANT))).rejects.toThrow(
        'Not authorized to delete this gym',
      );
      expect(revertFirst).toHaveBeenCalled();
    } finally {
      revertFirst.mockRestore();
    }

    const after = await gymRow(gym.id);
    expect(after).toMatchObject({ ownerId: SYSTEM_OWNER, deletedAt: null, syncFrozenAt: null });
    const [board] = await db
      .select({ gymId: dbSchema.userBoards.gymId })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, systemBoard.id));
    expect(board.gymId).toBe(gym.id);
  });
});

// ============================================================================
// Digest
// ============================================================================

describe('the daily digest section for claims that approved themselves', () => {
  it('lists each with the gym, the claimant, their account age and a revert link', async () => {
    const { claim } = await autoApprovedGym(CLAIMANT, 'Digest Gym');
    // An admin-approved claim is not in it.
    await setSetting('gym_claim_auto_approve', '0');
    const reviewedGym = await insertGym(SYSTEM_OWNER, 'Reviewed Gym');
    const reviewed = await insertPendingClaim(reviewedGym.id, OTHER_CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(reviewed.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );

    const window = { start: new Date(Date.now() - 60 * 60 * 1000), end: new Date(Date.now() + 60_000) };
    const section = await autoApprovedClaimsSection(window);
    expect(section).toMatchObject({ key: 'autoApprovedClaims', total: 1 });
    expect(section?.rows).toHaveLength(1);
    expect(section?.rows[0].label).toBe(`Digest Gym: claimed by User ${CLAIMANT}, account 60 days old`);
    expect(section?.rows[0].url).toMatch(new RegExp(`/admin/gym-claims\\?revert=${claim.id}$`));

    await socialGymClaimRevertMutations.revertGymClaim(
      null,
      { input: { claimId: String(claim.id) } },
      authCtx(GLOBAL_ADMIN),
    );
    expect((await autoApprovedClaimsSection(window))?.rows[0].label).toContain('(already reverted)');

    const earlier = { start: new Date(Date.now() - 3 * DAY_MS), end: new Date(Date.now() - 2 * DAY_MS) };
    expect(await autoApprovedClaimsSection(earlier)).toBeNull();
  });
});

// ============================================================================
// Expiry
// ============================================================================

describe('admin-review claims expire after 30 days', () => {
  const startsAt = new Date(GYM_CLAIM_EXPIRY_STARTS_AT).getTime();
  /** A time `days` days after expiry began. */
  const afterStart = (days: number) => new Date(startsAt + days * DAY_MS);

  it('expires stale admin claims filed since expiry began, and tells the claimant', async () => {
    const now = afterStart(40);
    const gym = await insertGym(SYSTEM_OWNER, 'Waiting Gym');
    const stale = await insertPendingClaim(gym.id, CLAIMANT, afterStart(1 / 24));
    const fresh = await insertPendingClaim(gym.id, OTHER_CLAIMANT, new Date(now.getTime() - 29 * DAY_MS));
    const staleDomain = await insertPendingClaim(gym.id, CREATOR, afterStart(1 / 24), 'domain');
    // Filed before expiry began: left for a person, however old.
    const backlog = await insertPendingClaim(gym.id, SECOND_CREATOR, afterStart(-1));

    const failures = { count: 0 };
    expect(await expireStaleAdminClaims(now, failures)).toBe(1);
    expect(failures.count).toBe(0);
    const statusOf = async (id: number) =>
      (await db.select().from(dbSchema.gymClaims).where(eq(dbSchema.gymClaims.id, id)))[0].status;
    expect(await statusOf(stale.id)).toBe('expired');
    expect(await statusOf(fresh.id)).toBe('pending');
    expect(await statusOf(staleDomain.id)).toBe('pending');
    expect(await statusOf(backlog.id)).toBe('pending');

    expect(await noticesFor(CLAIMANT, 'gym_claim_denied')).toEqual([
      expect.objectContaining({ entityType: 'gym', entityId: gym.uuid }),
    ]);
    expect(await noticesFor(OTHER_CLAIMANT, 'gym_claim_denied')).toEqual([]);
    expect(await noticesFor(SECOND_CREATOR, 'gym_claim_denied')).toEqual([]);
    await vi.waitFor(() =>
      expect(sendGymClaimExpiredEmail).toHaveBeenCalledWith(`${CLAIMANT}@test.com`, 'Waiting Gym'),
    );
    expect(sendGymClaimExpiredEmail).toHaveBeenCalledTimes(1);

    // Nothing is due twice.
    expect(await expireStaleAdminClaims(now, failures)).toBe(0);
  });

  it('runs as a step of the hourly sweep', async () => {
    const gym = await insertGym(SYSTEM_OWNER);
    await insertPendingClaim(gym.id, CLAIMANT, afterStart(1));
    expect((await runDirectoryReportSweep(afterStart(40))).claimsExpired).toBe(1);
  });
});

// ============================================================================
// Notices
// ============================================================================

describe('claim notices', () => {
  async function gymWithBoards() {
    const gym = await insertGym(SYSTEM_OWNER, 'Busy Gym');
    const oldest = await insertBoard(CREATOR, gym.id);
    await insertBoard(CREATOR, gym.id);
    await insertBoard(SECOND_CREATOR, gym.id);
    await insertBoard(PRIVATE_CREATOR, gym.id, { isPublic: false });
    await insertBoard(SYSTEM_OWNER, gym.id);
    await insertBoard(CLAIMANT, gym.id);
    return { gym, oldest };
  }

  async function approveByHand(gymId: number) {
    const claim = await insertPendingClaim(gymId, CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(claim.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );
  }

  it('tells each creator whose board the new owner can read, once, naming their oldest board', async () => {
    const { gym, oldest } = await gymWithBoards();
    await approveByHand(gym.id);

    const creatorNotices = await noticesFor(CREATOR, 'gym_claimed_with_your_board');
    expect(creatorNotices).toEqual([
      expect.objectContaining({ actorId: null, entityType: 'gym', entityId: gym.uuid, boardId: oldest.id }),
    ]);
    expect(await noticesFor(SECOND_CREATOR, 'gym_claimed_with_your_board')).toHaveLength(1);
    // A private board the new owner can't read, and their own board, send nothing.
    expect(await noticesFor(PRIVATE_CREATOR, 'gym_claimed_with_your_board')).toEqual([]);
    expect(await noticesFor(CLAIMANT, 'gym_claimed_with_your_board')).toEqual([]);

    const holder: { uuid: string; type: string; entityType: string; directoryNotice?: DirectoryNotice | null } = {
      uuid: creatorNotices[0].uuid,
      type: 'gym_claimed_with_your_board',
      entityType: 'gym',
    };
    await enrichDirectoryNotices([holder], CREATOR);
    expect(holder.directoryNotice).toMatchObject({
      targetKind: 'gym',
      gymUuid: gym.uuid,
      gymName: 'Busy Gym',
      boardUuid: oldest.uuid,
      boardName: oldest.name,
      recipientIsCreator: true,
    });
  });

  it('sends nothing while the directory-reports flag is off', async () => {
    setFlag(false);
    const { gym } = await gymWithBoards();
    await approveByHand(gym.id);
    expect(await noticesFor(CREATOR, 'gym_claimed_with_your_board')).toEqual([]);
  });

  it('tells a denied claimant in the app, while the flag is on', async () => {
    const gym = await insertGym(SYSTEM_OWNER, 'Denied Gym');
    const claim = await insertPendingClaim(gym.id, CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(claim.id), decision: 'deny' } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(await noticesFor(CLAIMANT, 'gym_claim_denied')).toEqual([
      expect.objectContaining({ actorId: null, entityType: 'gym', entityId: gym.uuid }),
    ]);

    setFlag(false);
    const other = await insertPendingClaim(gym.id, OTHER_CLAIMANT);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(other.id), decision: 'deny' } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(await noticesFor(OTHER_CLAIMANT, 'gym_claim_denied')).toEqual([]);
  });
});

// ============================================================================
// Review queue
// ============================================================================

describe('the review queue shows who is claiming', () => {
  it("returns the claimant's account age, logged climbs and gyms they already run", async () => {
    const gym = await insertGym(SYSTEM_OWNER, 'Queued Gym');
    await insertPendingClaim(gym.id, CLAIMANT);
    await insertGym(CLAIMANT, 'Owned Gym');
    const administered = await insertGym(OTHER_CLAIMANT, 'Administered Gym');
    await db.insert(dbSchema.gymMembers).values({ gymId: administered.id, userId: CLAIMANT, role: 'admin' });
    const editorOnly = await insertGym(OTHER_CLAIMANT, 'Edited Gym');
    await db.insert(dbSchema.gymMembers).values({ gymId: editorOnly.id, userId: CLAIMANT, role: 'editor' });
    for (const status of ['send', 'attempt'] as const) {
      await db.insert(dbSchema.boardseshTicks).values({
        uuid: uuidv4(),
        userId: CLAIMANT,
        boardType: 'kilter',
        climbUuid: `claim-history-${status}`,
        angle: 40,
        status,
        climbedAt: new Date().toISOString(),
      });
    }

    const queue = (await socialGymClaimQueries.pendingGymClaims(null, {}, authCtx(GLOBAL_ADMIN))) as {
      claims: Array<Record<string, unknown>>;
    };
    expect(queue.claims).toEqual([
      expect.objectContaining({
        gymName: 'Queued Gym',
        claimantAccountAgeDays: 60,
        claimantTickCount: 2,
        claimantGymsHeld: 2,
      }),
    ]);
  });
});

describe("the admin's list of claims that approved themselves", () => {
  type Listed = { claims: Array<Record<string, unknown>>; totalCount: number; hasMore: boolean };
  const list = (input: Record<string, unknown> = {}, userId = GLOBAL_ADMIN) =>
    socialGymClaimQueries.autoApprovedGymClaims(null, { input }, authCtx(userId)) as Promise<Listed>;

  it('lists auto-approvals newest first, keeps reverted ones, and leaves out hand approvals', async () => {
    const first = await autoApprovedGym(CLAIMANT, 'First Gym');
    await ageApproval(first.claim.id, 2);
    const second = await autoApprovedGym(OTHER_CLAIMANT, 'Second Gym');
    const byHand = await insertGym(SYSTEM_OWNER, 'Hand Gym');
    await insertPendingClaim(byHand.id, CREATOR);
    const pending = await claimFor(byHand.id, CREATOR);
    await socialGymClaimMutations.reviewGymClaim(
      null,
      { input: { claimId: String(pending.id), decision: 'approve' } },
      authCtx(GLOBAL_ADMIN),
    );
    await socialGymClaimRevertMutations.revertGymClaim(
      null,
      { input: { claimId: String(first.claim.id) } },
      authCtx(GLOBAL_ADMIN),
    );

    const listed = await list();
    expect(listed.totalCount).toBe(2);
    expect(listed.claims.map((claim) => [claim.gymName, claim.status])).toEqual([
      ['Second Gym', 'approved'],
      ['First Gym', 'revoked'],
    ]);
    expect(listed.claims[0]).toMatchObject({ id: String(second.claim.id), claimantAccountAgeDays: 60 });
    expect(typeof listed.claims[0].approvedAt).toBe('string');
  });

  it("narrows to the digest link's claim, and answers empty for one that didn't approve itself", async () => {
    const { claim } = await autoApprovedGym();
    await autoApprovedGym(OTHER_CLAIMANT, 'Other Gym');
    const queued = await insertGym(SYSTEM_OWNER, 'Queued Gym');
    await insertPendingClaim(queued.id, CREATOR);
    const pending = await claimFor(queued.id, CREATOR);

    expect((await list({ claimId: String(claim.id) })).claims.map((row) => row.id)).toEqual([String(claim.id)]);
    expect(await list({ claimId: String(pending.id) })).toEqual({ claims: [], totalCount: 0, hasMore: false });
  });

  it('is for global admins only', async () => {
    await expect(list({}, CLAIMANT)).rejects.toThrow();
  });
});

// ============================================================================
// Verify link errors
// ============================================================================

describe('the verify link names the gym when it fails', () => {
  async function follow(token: string): Promise<string> {
    const headers: Record<string, string> = {};
    const res = {
      writeHead: (_status: number, sent: Record<string, string>) => Object.assign(headers, sent),
      end: () => undefined,
    } as unknown as ServerResponse;
    await handleGymClaimVerify({} as IncomingMessage, res, new URL(`http://backend/verify?token=${token}`));
    return headers.Location;
  }

  it('adds ?gym= for a used link, and nothing for an unknown one', async () => {
    const gym = await insertGym(CREATOR, 'Linked Gym');
    const token = uuidv4();
    await db.insert(dbSchema.gymClaims).values({
      gymId: gym.id,
      claimantUserId: CLAIMANT,
      method: 'domain',
      status: 'denied',
      claimEmail: 'boss@linked.example.com',
      tokenHash: hashClaimToken(token),
      expiresAt: new Date(Date.now() + DAY_MS),
    });

    const used = new URL(await follow(token));
    expect(used.pathname).toBe('/gym-claim/error');
    expect(used.searchParams.get('reason')).toBe('used');
    expect(used.searchParams.get('gym')).toBe(gym.slug);

    const unknown = new URL(await follow(uuidv4()));
    expect(unknown.searchParams.get('reason')).toBe('invalid');
    expect(unknown.searchParams.has('gym')).toBe(false);
  });
});
