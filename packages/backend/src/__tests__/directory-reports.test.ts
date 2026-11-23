import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vite-plus/test';
import type { PgBoss } from 'pg-boss';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, DirectoryReport, GroupedNotificationConnection } from '@boardsesh/shared-schema';
import {
  DIRECTORY_REPORT_REASONS,
  DIRECTORY_REPORT_RECIPIENTS,
  DIRECTORY_REPORT_RESOLVER_ROLES,
  DIRECTORY_REPORT_STATUSES,
  DIRECTORY_REPORT_TARGET_KINDS,
} from '@boardsesh/directory-moderation';

vi.mock('../services/analytics/posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/analytics/posthog')>()),
  captureBackendEvent: vi.fn(() => true),
}));

vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  getJobQueue: vi.fn(() => null),
}));

vi.mock('../email/email-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/email-service')>()),
  sendGymDuplicateReportAdminNotification: vi.fn(() => Promise.resolve()),
  sendAdminDailyDigestEmail: vi.fn(() => Promise.resolve()),
}));

import { db } from '../db/client';
import { transactionWithAfterCommit } from '../db/after-commit';
import { sendAdminDailyDigestEmail } from '../email/email-service';
import { captureBackendEvent } from '../services/analytics/posthog';
import { getJobQueue } from '../services/job-queue';
import { recordBoardModerationEvent } from '../graphql/resolvers/social/board-moderation-events';
import { socialBoardMutations, socialBoardQueries, updateBoardRecord } from '../graphql/resolvers/social/boards';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { socialGymStrayBoardMutations } from '../graphql/resolvers/social/gym-stray-boards';
import { socialGymReportMutations } from '../graphql/resolvers/social/gym-reports';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import {
  directoryReportMutations,
  directoryReportQueries,
  resolveReportsForMergedBoard,
} from '../graphql/resolvers/social/directory-reports';
import {
  DIRECTORY_REPORT_PUSHES_PER_DAY,
  sendDirectoryNotices,
  settleDirectoryNoticePublishes,
} from '../graphql/resolvers/social/directory-reports/notices';
import { fileReport, prepareBoardReport } from '../graphql/resolvers/social/directory-reports/submit';
import { __resetDirectoryReportsFlagForTests } from '../services/directory-reports-flag';
import { isAdminDigestDue, maybeSendAdminDigest, runDirectoryReportSweep } from '../services/directory-report-sweep';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { resetGymDuplicateReportClaimsForTests } from '../utils/gym-duplicate-report-claims';

/**
 * Report a problem with a board or a gym (docs/product/directory-reports.md):
 * join semantics, routing, who reads what, every way a report closes, the
 * notices and their privacy, the sweep, and the `directory-reports` flag.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CREATOR = 'dr-creator';
const GYM_OWNER = 'dr-gym-owner';
const GYM_ADMIN = 'dr-gym-admin';
const GYM_EDITOR = 'dr-gym-editor';
const REPORTER_A = 'dr-reporter-a';
const REPORTER_B = 'dr-reporter-b';
const GLOBAL_ADMIN = 'dr-global-admin';
const OUTSIDER = 'dr-outsider';
const ALL_USERS = [
  SYSTEM_OWNER,
  CREATOR,
  GYM_OWNER,
  GYM_ADMIN,
  GYM_EDITOR,
  REPORTER_A,
  REPORTER_B,
  GLOBAL_ADMIN,
  OUTSIDER,
];

const BASE = { latitude: 47.0, longitude: 8.0 };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

type Ref = { id: number; uuid: string };

async function insertGym(ownerId: string, options: { runByGym?: boolean; name?: string } = {}): Promise<Ref> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: uuid, name: options.name ?? 'Report Gym', ownerId, isPublic: true, ...BASE })
    .returning({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid });
  if (options.runByGym) {
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: ownerId, method: 'admin', status: 'approved' });
  }
  return gym;
}

let boardCounter = 0;
async function insertBoard(
  ownerId: string,
  gymId: number | null,
  overrides: { isPublic?: boolean } = {},
): Promise<Ref> {
  const uuid = uuidv4();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      name: `Wall ${boardCounter}`,
      ownerId,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 700 + boardCounter++,
      setIds: '1,2',
      gymId,
      isPublic: overrides.isPublic ?? true,
      angle: 40,
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  return board;
}

type SubmitResult = { status: string; reportUuid: string; routedTo: string[]; otherReporterCount: number };

const reportBoard = (userId: string, input: Record<string, unknown>) =>
  directoryReportMutations.reportBoard(null, { input }, authCtx(userId)) as Promise<SubmitResult>;
const reportGym = (userId: string, input: Record<string, unknown>) =>
  directoryReportMutations.reportGym(null, { input }, authCtx(userId)) as Promise<SubmitResult>;
const resolveReport = (userId: string, input: Record<string, unknown>) =>
  directoryReportMutations.resolveDirectoryReport(null, { input }, authCtx(userId)) as Promise<DirectoryReport>;
const boardReports = (userId: string, boardUuid: string) =>
  directoryReportQueries.boardReports(null, { boardUuid }, authCtx(userId)) as Promise<DirectoryReport[]>;
const detach = (gymUuid: string, boardUuid: string, userId: string) =>
  socialGymStrayBoardMutations.detachBoardFromGym(null, { input: { gymUuid, boardUuid } }, authCtx(userId));
const attach = (gymUuid: string, boardUuid: string, userId: string) =>
  socialGymStrayBoardMutations.attachBoardToGym(null, { input: { gymUuid, boardUuid } }, authCtx(userId));

async function reportRow(uuid: string) {
  const [row] = await db.select().from(dbSchema.directoryReports).where(eq(dbSchema.directoryReports.uuid, uuid));
  return row;
}

async function noticesFor(recipientId: string, type?: string) {
  const rows = await db
    .select({
      type: dbSchema.notifications.type,
      actorId: dbSchema.notifications.actorId,
      entityType: dbSchema.notifications.entityType,
      entityId: dbSchema.notifications.entityId,
      isReminder: dbSchema.directoryNotificationContext.isReminder,
    })
    .from(dbSchema.notifications)
    .leftJoin(
      dbSchema.directoryNotificationContext,
      eq(dbSchema.directoryNotificationContext.notificationUuid, dbSchema.notifications.uuid),
    )
    .where(eq(dbSchema.notifications.recipientId, recipientId));
  return type ? rows.filter((row) => row.type === type) : rows;
}

/** A job queue that accepts every push job, for the tests that count pushes. */
const fakeBoss = { send: vi.fn() } as unknown as PgBoss & { send: ReturnType<typeof vi.fn> };

async function registerDevice(userId: string) {
  await db.insert(dbSchema.notificationDevices).values({
    installationId: `install-${userId}`,
    userId,
    token: `ExponentPushToken[${userId}]`,
    platform: 'ios',
    locale: 'en-US',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

let runGym: Ref;
let climberBoard: Ref;
const savedOverrides = process.env.FEATURE_FLAG_OVERRIDES;

function setFlag(on: boolean) {
  process.env.FEATURE_FLAG_OVERRIDES = on ? 'directory-reports' : 'directory-reports=false';
  __resetDirectoryReportsFlagForTests();
}

beforeEach(async () => {
  resetAllRateLimits();
  resetGymDuplicateReportClaimsForTests();
  setFlag(true);
  vi.mocked(sendAdminDailyDigestEmail).mockClear();
  vi.mocked(captureBackendEvent).mockClear();
  vi.mocked(captureBackendEvent).mockImplementation(() => true);
  vi.mocked(getJobQueue).mockReturnValue(null);
  vi.mocked(fakeBoss.send).mockReset();
  vi.mocked(fakeBoss.send).mockResolvedValue('job-id');
  await db.execute(sql`
    TRUNCATE TABLE
      "directory_notification_context", "directory_report_reporters", "directory_reports", "admin_daily_digests",
      "notifications", "notification_devices", "resource_privacy", "resource_grants",
      "community_roles", "gym_members", "gym_follows", "gym_claims", "gym_owner_reassignments",
      "board_moderation_events", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: id })))
    .onConflictDoNothing();
  runGym = await insertGym(GYM_OWNER, { runByGym: true, name: 'Crux' });
  await db.insert(dbSchema.gymMembers).values([
    { gymId: runGym.id, userId: GYM_ADMIN, role: 'admin' },
    { gymId: runGym.id, userId: GYM_EDITOR, role: 'editor' },
  ]);
  await db.insert(dbSchema.communityRoles).values([{ userId: GLOBAL_ADMIN, role: 'admin', boardType: null }]);
  climberBoard = await insertBoard(CREATOR, runGym.id);
});

afterEach(() => {
  if (savedOverrides === undefined) delete process.env.FEATURE_FLAG_OVERRIDES;
  else process.env.FEATURE_FLAG_OVERRIDES = savedOverrides;
  __resetDirectoryReportsFlagForTests();
});

afterAll(async () => {
  await settleDirectoryNoticePublishes();
});

describe('the database enums match @boardsesh/directory-moderation', () => {
  it('lists the same values', () => {
    expect(dbSchema.directoryReportReasonEnum.enumValues).toEqual([...DIRECTORY_REPORT_REASONS]);
    expect(dbSchema.directoryReportStatusEnum.enumValues).toEqual([...DIRECTORY_REPORT_STATUSES]);
    expect(dbSchema.directoryReportRecipientEnum.enumValues).toEqual([...DIRECTORY_REPORT_RECIPIENTS]);
    expect(dbSchema.directoryReportResolverRoleEnum.enumValues).toEqual([...DIRECTORY_REPORT_RESOLVER_ROLES]);
    expect(dbSchema.directoryReportTargetKindEnum.enumValues).toEqual([...DIRECTORY_REPORT_TARGET_KINDS]);
  });
});

describe('reportBoard: join semantics', () => {
  it('opens a report, joins a second reporter, and answers a repeat as already_reported', async () => {
    const first = await reportBoard(REPORTER_A, {
      boardUuid: climberBoard.uuid,
      reason: 'wrong_setup',
      note: '  12x14 at 40°  ',
    });
    expect(first).toMatchObject({ status: 'created', routedTo: ['creator', 'gym_staff'], otherReporterCount: 0 });

    const second = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    expect(second).toMatchObject({ status: 'added', reportUuid: first.reportUuid, otherReporterCount: 1 });

    const again = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    expect(again).toMatchObject({ status: 'already_reported', reportUuid: first.reportUuid, otherReporterCount: 1 });

    const reports = await db.select().from(dbSchema.directoryReports);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: 'open', gymIdAtReport: runGym.id, routedTo: ['creator', 'gym_staff'] });
    const reporters = await db.select().from(dbSchema.directoryReportReporters);
    expect(reporters.map((row) => [row.reporterId, row.note])).toEqual([
      [REPORTER_A, '12x14 at 40°'],
      [REPORTER_B, null],
    ]);
  });

  it('a different reason is a different report', async () => {
    const setup = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    const gone = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    expect(gone.status).toBe('created');
    expect(gone.reportUuid).not.toBe(setup.reportUuid);
  });

  it('tells the creator and gym owner and admins once, with no actor, and not the editor or reporters', async () => {
    await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    for (const recipient of [CREATOR, GYM_OWNER, GYM_ADMIN]) {
      const notices = await noticesFor(recipient, 'board_report_opened');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ actorId: null, entityType: 'board', entityId: climberBoard.uuid });
    }
    for (const nobody of [GYM_EDITOR, REPORTER_A, REPORTER_B, OUTSIDER]) {
      expect(await noticesFor(nobody)).toHaveLength(0);
    }
  });

  it('checks the note: required for "something else", capped, trimmed', async () => {
    await expect(reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'other' })).rejects.toThrow(
      /at least 10 characters/,
    );
    await expect(
      reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'other', note: '   too short   ' }),
    ).rejects.toThrow(/at least 10 characters/);
    await expect(
      reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone', note: 'x'.repeat(501) }),
    ).rejects.toThrow(/under 500/);
    const ok = await reportBoard(REPORTER_A, {
      boardUuid: climberBoard.uuid,
      reason: 'other',
      note: '  the holds are all different  ',
    });
    expect(ok.status).toBe('created');
  });

  it('refuses a board the reporter cannot read, as not found', async () => {
    const privateBoard = await insertBoard(CREATOR, runGym.id, { isPublic: false });
    await expect(reportBoard(OUTSIDER, { boardUuid: privateBoard.uuid, reason: 'gone' })).rejects.toThrow(
      /Board not found/,
    );
  });

  it('a duplicate report names the other board; other reasons may not', async () => {
    const twin = await insertBoard(CREATOR, runGym.id);
    const filed = await reportBoard(REPORTER_A, {
      boardUuid: climberBoard.uuid,
      reason: 'duplicate',
      duplicateOfBoardUuid: twin.uuid,
    });
    expect((await reportRow(filed.reportUuid)).duplicateOfBoardId).toBe(twin.id);
    await expect(
      reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone', duplicateOfBoardUuid: twin.uuid }),
    ).rejects.toThrow(/Only a "listed twice"/);
  });
});

describe('reportBoard: routing (decision 2)', () => {
  it('a synced board at an unclaimed gym goes straight to the admin queue and tells nobody', async () => {
    const unclaimed = await insertGym(SYSTEM_OWNER);
    const synced = await insertBoard(SYSTEM_OWNER, unclaimed.id);
    const filed = await reportBoard(REPORTER_A, { boardUuid: synced.uuid, reason: 'gone' });
    expect(filed.routedTo).toEqual(['admin']);
    const row = await reportRow(filed.reportUuid);
    expect(row.status).toBe('escalated');
    expect(row.escalatedAt).not.toBeNull();
    expect(await db.select().from(dbSchema.notifications)).toHaveLength(0);
  });

  it('a climber board at a climber-listed gym goes to its creator only', async () => {
    const climberGym = await insertGym(OUTSIDER);
    const board = await insertBoard(CREATOR, climberGym.id);
    const filed = await reportBoard(REPORTER_A, { boardUuid: board.uuid, reason: 'wrong_setup' });
    expect(filed.routedTo).toEqual(['creator']);
    expect(await noticesFor(OUTSIDER)).toHaveLength(0);
  });

  it('wrong gym or place also goes to the admin queue at once', async () => {
    const filed = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    expect(filed.routedTo).toEqual(['creator', 'gym_staff', 'admin']);
    expect((await reportRow(filed.reportUuid)).status).toBe('escalated');
  });

  it('no notice about a private board to staff who cannot read it', async () => {
    const privateBoard = await insertBoard(CREATOR, runGym.id, { isPublic: false });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'board',
      resourceId: privateBoard.uuid,
      ownerId: CREATOR,
      audience: 'invite_only',
    });
    await db
      .insert(dbSchema.resourceGrants)
      .values({ kind: 'board', resourceId: privateBoard.uuid, userId: REPORTER_A, status: 'approved' });
    const filed = await reportBoard(REPORTER_A, { boardUuid: privateBoard.uuid, reason: 'gone' });
    expect(filed.status).toBe('created');
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(1);
    expect(await noticesFor(GYM_OWNER)).toHaveLength(0);
    expect(await noticesFor(GYM_ADMIN)).toHaveLength(0);
    // ...and staff don't read it through the reports either.
    expect(await boardReports(GYM_ADMIN, privateBoard.uuid)).toEqual([]);
  });
});

describe('reads: who sees a report, and reporter anonymity', () => {
  beforeEach(async () => {
    await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup', note: 'It is 12x14 now' });
    await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
  });

  it('the creator and staff read notes and a count, never names', async () => {
    for (const viewer of [CREATOR, GYM_OWNER, GYM_ADMIN, GYM_EDITOR]) {
      const [report] = await boardReports(viewer, climberBoard.uuid);
      expect(report).toMatchObject({ reason: 'wrong_setup', reporterCount: 2, gymName: 'Crux' });
      expect(report.notes).toEqual([expect.objectContaining({ note: 'It is 12x14 now', reporter: null })]);
    }
    expect((await boardReports(CREATOR, climberBoard.uuid))[0]).toMatchObject({
      viewerRole: 'creator',
      viewerCanResolve: true,
    });
    expect((await boardReports(GYM_ADMIN, climberBoard.uuid))[0]).toMatchObject({
      viewerRole: 'gym_staff',
      viewerCanResolve: true,
    });
    // Editors read but don't close.
    expect((await boardReports(GYM_EDITOR, climberBoard.uuid))[0]).toMatchObject({ viewerCanResolve: false });
  });

  it('a global admin sees who reported', async () => {
    const [report] = await boardReports(GLOBAL_ADMIN, climberBoard.uuid);
    expect(report.viewerRole).toBe('admin');
    expect(report.notes[0].reporter).toMatchObject({ userId: REPORTER_A });
  });

  it('reporters and strangers read nothing', async () => {
    expect(await boardReports(REPORTER_A, climberBoard.uuid)).toEqual([]);
    expect(await boardReports(OUTSIDER, climberBoard.uuid)).toEqual([]);
  });

  it('UserBoard counts waiting reports for those who can act, and tells a reporter they reported it', async () => {
    const asCreator = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(CREATOR));
    expect(asCreator).toMatchObject({ openReportCount: 1, viewerHasOpenReport: false });
    const asStaff = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(GYM_EDITOR));
    expect(asStaff).toMatchObject({ openReportCount: 1 });
    const asReporter = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(REPORTER_A));
    expect(asReporter).toMatchObject({ openReportCount: null, viewerHasOpenReport: true });
    const asStranger = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(OUTSIDER));
    expect(asStranger).toMatchObject({ openReportCount: null, viewerHasOpenReport: false });
  });

  it('myDirectoryReportsToReview lists reports on my boards and at my gym', async () => {
    for (const viewer of [CREATOR, GYM_OWNER, GYM_EDITOR]) {
      const reports = (await directoryReportQueries.myDirectoryReportsToReview(
        null,
        {},
        authCtx(viewer),
      )) as DirectoryReport[];
      expect(reports.map((report) => report.reason)).toEqual(['wrong_setup']);
    }
    expect(await directoryReportQueries.myDirectoryReportsToReview(null, {}, authCtx(OUTSIDER))).toEqual([]);
  });

  it('the admin queue is global admins only', async () => {
    await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    const page = (await directoryReportQueries.adminDirectoryReports(null, {}, authCtx(GLOBAL_ADMIN))) as {
      reports: DirectoryReport[];
    };
    expect(page.reports.map((report) => report.reason)).toEqual(['wrong_place']);
    await expect(directoryReportQueries.adminDirectoryReports(null, {}, authCtx(GYM_OWNER))).rejects.toThrow(/Admin/);
  });

  it('the creator renders the reported notice from directoryNotice', async () => {
    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(CREATOR),
    )) as GroupedNotificationConnection;
    const group = feed.groups.find((candidate) => candidate.type === 'board_report_opened');
    expect(group?.actors).toEqual([]);
    expect(group?.directoryNotice).toMatchObject({
      targetKind: 'board',
      boardUuid: climberBoard.uuid,
      gymName: 'Crux',
      reason: 'wrong_setup',
      isReminder: false,
      recipientIsCreator: true,
    });
  });
});

describe('myDirectoryReportsToReview: the page', () => {
  const toReview = (viewer: string, first: number) =>
    directoryReportQueries.myDirectoryReportsToReview(null, { first }, authCtx(viewer)) as Promise<DirectoryReport[]>;

  it('reports on a board staff cannot read take no place on their page', async () => {
    const privateBoard = await insertBoard(CREATOR, runGym.id, { isPublic: false });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'board',
      resourceId: privateBoard.uuid,
      ownerId: CREATOR,
      audience: 'invite_only',
    });
    await db
      .insert(dbSchema.resourceGrants)
      .values({ kind: 'board', resourceId: privateBoard.uuid, userId: REPORTER_A, status: 'approved' });
    const hidden = [
      await reportBoard(REPORTER_A, { boardUuid: privateBoard.uuid, reason: 'gone' }),
      await reportBoard(REPORTER_A, { boardUuid: privateBoard.uuid, reason: 'wrong_setup' }),
    ];
    // The oldest waiting reports, routed to the gym: they head the page's order.
    for (const [index, { reportUuid }] of hidden.entries()) {
      await db
        .update(dbSchema.directoryReports)
        .set({ createdAt: new Date(Date.now() - (5 - index) * 24 * 60 * 60 * 1000) })
        .where(eq(dbSchema.directoryReports.uuid, reportUuid));
      expect((await reportRow(reportUuid)).routedTo).toContain('gym_staff');
    }
    const readable = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'gone' });

    for (const staff of [GYM_OWNER, GYM_ADMIN, GYM_EDITOR]) {
      expect((await toReview(staff, 1)).map((report) => report.uuid)).toEqual([readable.reportUuid]);
    }
    // The creator reads all three, oldest first.
    expect((await toReview(CREATOR, 3)).map((report) => report.uuid)).toEqual([
      ...hidden.map((report) => report.reportUuid),
      readable.reportUuid,
    ]);
  });
});

describe('resolveDirectoryReport', () => {
  let reportUuid: string;
  beforeEach(async () => {
    ({ reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' }));
  });

  it('the creator keeps it; the reporters hear the outcome and the note', async () => {
    const resolved = await resolveReport(CREATOR, { reportUuid, outcome: 'kept', note: ' We reset it last week. ' });
    expect(resolved).toMatchObject({
      status: 'kept',
      resolvedByRole: 'creator',
      resolutionNote: 'We reset it last week.',
    });
    expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(1);
    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(REPORTER_A),
    )) as GroupedNotificationConnection;
    expect(feed.groups[0].directoryNotice).toMatchObject({
      outcome: 'kept',
      resolvedByRole: 'creator',
      resolutionNote: 'We reset it last week.',
    });
    await expect(resolveReport(CREATOR, { reportUuid, outcome: 'kept' })).rejects.toThrow(/closed already/);
  });

  it('gym staff (owner or admin) keep it; an editor may not; a reporter or stranger cannot see it', async () => {
    await expect(resolveReport(GYM_EDITOR, { reportUuid, outcome: 'kept' })).rejects.toThrow(/owner or admins/);
    await expect(resolveReport(REPORTER_A, { reportUuid, outcome: 'kept' })).rejects.toThrow(/Report not found/);
    await expect(resolveReport(OUTSIDER, { reportUuid, outcome: 'kept' })).rejects.toThrow(/Report not found/);
    expect(await resolveReport(GYM_ADMIN, { reportUuid, outcome: 'kept' })).toMatchObject({
      status: 'kept',
      resolvedByRole: 'gym_staff',
    });
  });

  it('only a global admin closes with another outcome, and only once it happened', async () => {
    await expect(resolveReport(CREATOR, { reportUuid, outcome: 'deleted' })).rejects.toThrow(/Fix, remove or delete/);
    await expect(resolveReport(GLOBAL_ADMIN, { reportUuid, outcome: 'deleted' })).rejects.toThrow(
      /Delete the board first/,
    );
    expect(await resolveReport(GLOBAL_ADMIN, { reportUuid, outcome: 'fixed' })).toMatchObject({
      status: 'fixed',
      resolvedByRole: 'admin',
    });
  });
});

describe('closing a report with the action itself', () => {
  it('an edit to the setup fixes "set up wrong"; a timer-only edit does not', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    await updateBoardRecord({ boardUuid: climberBoard.uuid, timerName: 'Crux timer' }, authCtx(CREATOR));
    expect((await reportRow(reportUuid)).status).toBe('open');
    await updateBoardRecord({ boardUuid: climberBoard.uuid, angle: 45 }, authCtx(CREATOR));
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'fixed', resolvedByRole: 'creator' });
    expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(1);
  });

  it('a staff edit fixes it too, and tells the creator', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    await updateBoardRecord({ boardUuid: climberBoard.uuid, name: 'Crux Kilter 12x14' }, authCtx(GYM_OWNER));
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'fixed', resolvedByRole: 'gym_staff' });
    expect(await noticesFor(CREATOR, 'board_edited_by_staff')).toHaveLength(1);
  });

  it('an edit closes only "set up wrong"', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await updateBoardRecord({ boardUuid: climberBoard.uuid, angle: 45 }, authCtx(CREATOR));
    expect((await reportRow(reportUuid)).status).toBe('open');
  });

  it('staff removal closes the reports filed at that gym as removed and tells the creator', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await detach(runGym.uuid, climberBoard.uuid, GYM_EDITOR);
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'removed', resolvedByRole: 'gym_staff' });
    expect(await noticesFor(CREATOR, 'board_removed_from_gym')).toHaveLength(1);
    expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(1);
  });

  it('the creator unlinking their own board closes the reports filed at that gym as removed', async () => {
    const gone = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    const wrongSetup = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'wrong_setup' });
    await socialGymMutations.linkBoardToGym(
      null,
      { input: { boardUuid: climberBoard.uuid, gymUuid: null } },
      authCtx(CREATOR),
    );
    expect(await reportRow(gone.reportUuid)).toMatchObject({
      status: 'removed',
      resolvedBy: CREATOR,
      resolvedByRole: 'creator',
    });
    expect((await reportRow(wrongSetup.reportUuid)).status).toBe('removed');
    expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(1);
    expect(await noticesFor(REPORTER_B, 'board_report_resolved')).toHaveLength(1);
    expect(await noticesFor(CREATOR, 'board_removed_from_gym')).toHaveLength(0);
  });

  it('the creator taking their own board off the gym as staff closes them as removed, with no notice to themselves', async () => {
    // A creator who is also gym staff removes their own board as `board_owner`.
    await db.insert(dbSchema.gymMembers).values({ gymId: runGym.id, userId: CREATOR, role: 'editor' });
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await detach(runGym.uuid, climberBoard.uuid, CREATOR);
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'removed', resolvedByRole: 'creator' });
    expect(await noticesFor(CREATOR, 'board_removed_from_gym')).toHaveLength(0);
  });

  it('a delete closes every report as deleted, and the reporters still read the notice', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await socialBoardMutations.deleteBoard(null, { boardUuid: climberBoard.uuid }, authCtx(CREATOR));
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'deleted', resolvedByRole: 'creator' });
    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(REPORTER_A),
    )) as GroupedNotificationConnection;
    expect(feed.groups.map((group) => [group.type, group.directoryNotice?.outcome])).toEqual([
      ['board_report_resolved', 'deleted'],
    ]);
  });

  it('a global admin deleting a climber board tells the creator', async () => {
    await socialBoardMutations.deleteBoard(null, { boardUuid: climberBoard.uuid }, authCtx(GLOBAL_ADMIN));
    expect(await noticesFor(CREATOR, 'board_deleted_by_staff')).toHaveLength(1);
    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(CREATOR),
    )) as GroupedNotificationConnection;
    expect(feed.groups[0].directoryNotice).toMatchObject({ actorRole: 'moderator', recipientIsCreator: true });
  });

  it('counts a close only once the action commits; a rolled-back action counts nothing', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    const capturedEvents = () => vi.mocked(captureBackendEvent).mock.calls.map(([event]) => event);
    vi.mocked(captureBackendEvent).mockClear();

    await expect(
      transactionWithAfterCommit(async (tx) => {
        await recordBoardModerationEvent(tx, {
          boardId: climberBoard.id,
          gymId: runGym.id,
          actorUserId: GYM_ADMIN,
          actorRole: 'gym_admin',
          action: 'removed_from_gym',
          details: { mutation: 'detachBoardFromGym' },
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await reportRow(reportUuid)).status).toBe('open');
    expect(capturedEvents()).toEqual([]);

    // When the events go out, the close is already visible outside the transaction.
    const statusWhenCounted: Array<Promise<string>> = [];
    vi.mocked(captureBackendEvent).mockImplementation((event) => {
      if (event === 'Board Report Resolved') statusWhenCounted.push(reportRow(reportUuid).then((row) => row.status));
      return true;
    });
    await detach(runGym.uuid, climberBoard.uuid, GYM_ADMIN);
    expect(capturedEvents()).toEqual(['Board Removed From Gym', 'Board Report Resolved']);
    expect(await Promise.all(statusWhenCounted)).toEqual(['removed']);
  });

  it('the merge tool hook closes reports on the merged board and "listed twice" on the survivor', async () => {
    const survivor = await insertBoard(CREATOR, runGym.id);
    const onMerged = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    const onSurvivor = await reportBoard(REPORTER_A, {
      boardUuid: survivor.uuid,
      reason: 'duplicate',
      duplicateOfBoardUuid: climberBoard.uuid,
    });
    expect(await resolveReportsForMergedBoard(climberBoard.id, survivor.id)).toBe(2);
    expect(await reportRow(onMerged.reportUuid)).toMatchObject({ status: 'merged', resolvedByRole: 'auto' });
    expect((await reportRow(onSurvivor.reportUuid)).status).toBe('merged');
  });
});

describe('the admin queue', () => {
  it('a report routed to the admin queue or escalated is closed by a global admin only; the creator and staff read it', async () => {
    // "Wrong gym or place" goes to the admin queue at once.
    const wrongPlace = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    for (const viewer of [CREATOR, GYM_OWNER]) {
      expect(await boardReports(viewer, climberBoard.uuid)).toEqual([
        expect.objectContaining({ uuid: wrongPlace.reportUuid, viewerCanResolve: false }),
      ]);
      await expect(resolveReport(viewer, { reportUuid: wrongPlace.reportUuid, outcome: 'kept' })).rejects.toThrow(
        /team is looking at this report/,
      );
    }

    // So is a report that waited fourteen days.
    const gone = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await db
      .update(dbSchema.directoryReports)
      .set({ status: 'escalated', escalatedAt: new Date() })
      .where(eq(dbSchema.directoryReports.uuid, gone.reportUuid));
    await expect(resolveReport(CREATOR, { reportUuid: gone.reportUuid, outcome: 'kept' })).rejects.toThrow(
      /team is looking at this report/,
    );
    await expect(resolveReport(GYM_ADMIN, { reportUuid: gone.reportUuid, outcome: 'kept' })).rejects.toThrow(
      /team is looking at this report/,
    );
    expect(await resolveReport(GLOBAL_ADMIN, { reportUuid: gone.reportUuid, outcome: 'kept' })).toMatchObject({
      status: 'kept',
      resolvedByRole: 'admin',
    });
  });

  it("the creator's own unlink leaves reports in the admin queue open", async () => {
    const wrongPlace = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    const gone = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await socialGymMutations.linkBoardToGym(
      null,
      { input: { boardUuid: climberBoard.uuid, gymUuid: null } },
      authCtx(CREATOR),
    );
    expect((await reportRow(wrongPlace.reportUuid)).status).toBe('escalated');
    expect((await reportRow(gone.reportUuid)).status).toBe('removed');
  });

  it("staff taking the board off their gym still close it: that is the gym's own call", async () => {
    const wrongPlace = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    await detach(runGym.uuid, climberBoard.uuid, GYM_ADMIN);
    expect(await reportRow(wrongPlace.reportUuid)).toMatchObject({ status: 'removed', resolvedByRole: 'gym_staff' });
  });

  it('a report the sweep escalates after the creator or staff are checked, and before the write, stays open', async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    for (const [closer, reason] of [
      [CREATOR, 'gone'],
      [GYM_ADMIN, 'wrong_setup'],
    ] as const) {
      const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason });
      // Still open, but due: the next sweep moves it to the admin queue.
      await db
        .update(dbSchema.directoryReports)
        .set({ createdAt: fifteenDaysAgo })
        .where(eq(dbSchema.directoryReports.uuid, reportUuid));
      // The resolver has read and authorized the open report; the sweep runs
      // just before its write's transaction opens.
      const realTransaction = db.transaction.bind(db);
      const sweepFirst = vi.spyOn(db, 'transaction').mockImplementationOnce(async (work, config) => {
        expect((await runDirectoryReportSweep()).escalated).toBe(1);
        return realTransaction(work, config);
      });
      try {
        await expect(resolveReport(closer, { reportUuid, outcome: 'kept' })).rejects.toThrow(
          /team is looking at this report/,
        );
        expect(sweepFirst).toHaveBeenCalled();
      } finally {
        sweepFirst.mockRestore();
      }
      expect(await reportRow(reportUuid)).toMatchObject({ status: 'escalated', resolvedAt: null });
      expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(0);
    }
    // The team still closes it.
    const [escalated] = await db
      .select({ uuid: dbSchema.directoryReports.uuid })
      .from(dbSchema.directoryReports)
      .where(eq(dbSchema.directoryReports.reason, 'gone'));
    expect(await resolveReport(GLOBAL_ADMIN, { reportUuid: escalated.uuid, outcome: 'kept' })).toMatchObject({
      status: 'kept',
      resolvedByRole: 'admin',
    });
  });
});

describe('filing against the board as it stands', () => {
  it('a board deleted between the checks and the write is not found', async () => {
    const prepared = await prepareBoardReport(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await db
      .update(dbSchema.userBoards)
      .set({ deletedAt: new Date() })
      .where(eq(dbSchema.userBoards.id, climberBoard.id));
    await expect(fileReport(prepared)).rejects.toThrow(/Board not found/);
    expect(await db.select().from(dbSchema.directoryReports)).toHaveLength(0);
  });

  it('a board taken off its gym between the checks and the write is routed again', async () => {
    const prepared = await prepareBoardReport(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    expect(prepared.routing.recipients).toEqual(['creator', 'gym_staff']);
    await db.update(dbSchema.userBoards).set({ gymId: null }).where(eq(dbSchema.userBoards.id, climberBoard.id));
    const filed = await fileReport(prepared);
    expect(filed.report).toMatchObject({ gymIdAtReport: null, routedTo: ['creator'] });
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(1);
    expect(await noticesFor(GYM_OWNER, 'board_report_opened')).toHaveLength(0);
  });

  it('about a deleted board, only its creator and its reporters hear', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    const report = await reportRow(reportUuid);
    await db
      .update(dbSchema.userBoards)
      .set({ deletedAt: new Date() })
      .where(eq(dbSchema.userBoards.id, climberBoard.id));
    const target = { kind: 'board', boardId: climberBoard.id, boardUuid: climberBoard.uuid, ownerId: CREATOR } as const;
    const written = await sendDirectoryNotices(db, [
      { recipientId: GYM_OWNER, type: 'board_report_opened', target, reportId: report.id, isReminder: true },
      { recipientId: REPORTER_B, type: 'board_report_resolved', target, reportId: report.id },
      { recipientId: REPORTER_A, type: 'board_report_resolved', target, reportId: report.id },
      { recipientId: CREATOR, type: 'board_deleted_by_staff', target },
    ]);
    expect(written).toHaveLength(2);
    expect(await noticesFor(REPORTER_A, 'board_report_resolved')).toHaveLength(1);
    expect(await noticesFor(REPORTER_B)).toHaveLength(0);
    expect((await noticesFor(GYM_OWNER, 'board_report_opened')).filter((row) => row.isReminder)).toHaveLength(0);
  });
});

describe('repeat reports and pushes', () => {
  it("a reporter whose report closed can't open it again for seven days, but joins one someone else opens", async () => {
    const first = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await resolveReport(CREATOR, { reportUuid: first.reportUuid, outcome: 'kept' });

    expect(await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' })).toMatchObject({
      status: 'already_reported',
      reportUuid: first.reportUuid,
    });
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(1);

    const second = await reportBoard(REPORTER_B, { boardUuid: climberBoard.uuid, reason: 'gone' });
    expect(second.status).toBe('created');
    expect(await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' })).toMatchObject({
      status: 'added',
      reportUuid: second.reportUuid,
    });
  });

  it('after seven days the reporter can open it again', async () => {
    const first = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await resolveReport(CREATOR, { reportUuid: first.reportUuid, outcome: 'kept' });
    await db
      .update(dbSchema.directoryReports)
      .set({ resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(dbSchema.directoryReports.uuid, first.reportUuid));
    const again = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    expect(again.status).toBe('created');
    expect(again.reportUuid).not.toBe(first.reportUuid);
  });

  it('pushes at most ten report notices a day to one person; the rest stay in the inbox', async () => {
    vi.mocked(getJobQueue).mockReturnValue(fakeBoss);
    await registerDevice(CREATOR);
    const total = DIRECTORY_REPORT_PUSHES_PER_DAY + 2;
    for (let index = 0; index < total; index += 1) {
      const board = await insertBoard(CREATOR, null);
      await sendDirectoryNotices(db, [
        {
          recipientId: CREATOR,
          type: 'board_report_opened',
          target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: CREATOR },
          push: true,
        },
      ]);
    }
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(total);
    const deliveries = await db
      .select()
      .from(dbSchema.notificationDeliveries)
      .where(eq(dbSchema.notificationDeliveries.recipientId, CREATOR));
    expect(deliveries).toHaveLength(DIRECTORY_REPORT_PUSHES_PER_DAY);
  });
});

describe('relist_request', () => {
  beforeEach(async () => {
    await detach(runGym.uuid, climberBoard.uuid, GYM_ADMIN);
  });

  it('goes to the staff of the gym that removed it, never back to the creator', async () => {
    const filed = await reportBoard(CREATOR, {
      boardUuid: climberBoard.uuid,
      reason: 'relist_request',
      note: 'This is the gym wall',
    });
    expect(filed).toMatchObject({ status: 'created', routedTo: ['gym_staff'] });
    expect((await reportRow(filed.reportUuid)).gymIdAtReport).toBe(runGym.id);
    expect(await noticesFor(GYM_OWNER, 'board_report_opened')).toHaveLength(1);
    expect(await noticesFor(GYM_ADMIN, 'board_report_opened')).toHaveLength(1);
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(0);
    // Staff read it; the creator's own review list does not show it.
    expect(await boardReports(GYM_OWNER, climberBoard.uuid)).toHaveLength(1);
    expect(await boardReports(CREATOR, climberBoard.uuid)).toEqual([]);
  });

  it('only the creator files it, and only while the board is held off', async () => {
    await expect(reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'relist_request' })).rejects.toThrow(
      /Only the climber who added this board/,
    );
    const neverRemoved = await insertBoard(CREATOR, null);
    await expect(reportBoard(CREATOR, { boardUuid: neverRemoved.uuid, reason: 'relist_request' })).rejects.toThrow(
      /wasn't taken off a gym/,
    );
  });

  it('staff putting it back closes the request as fixed and tells the creator', async () => {
    const filed = await reportBoard(CREATOR, { boardUuid: climberBoard.uuid, reason: 'relist_request' });
    await attach(runGym.uuid, climberBoard.uuid, GYM_OWNER);
    expect(await reportRow(filed.reportUuid)).toMatchObject({ status: 'fixed', resolvedByRole: 'gym_staff' });
    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(CREATOR),
    )) as GroupedNotificationConnection;
    const resolved = feed.groups.find((group) => group.type === 'board_report_resolved');
    expect(resolved?.directoryNotice).toMatchObject({ reason: 'relist_request', outcome: 'fixed', gymName: 'Crux' });
  });
});

describe('reportGym', () => {
  it('wrong details go to the staff of a gym run by the gym', async () => {
    const filed = await reportGym(REPORTER_A, { gymUuid: runGym.uuid, reason: 'wrong_details' });
    expect(filed.routedTo).toEqual(['gym_staff']);
    expect(await noticesFor(GYM_OWNER, 'gym_report_opened')).toHaveLength(1);
    expect(await noticesFor(GYM_EDITOR)).toHaveLength(0);
  });

  it('a change to the details fixes "wrong details"; a save that changes none of them does not', async () => {
    const wrongDetails = await reportGym(REPORTER_A, { gymUuid: runGym.uuid, reason: 'wrong_details' });
    const closed = await reportGym(REPORTER_B, { gymUuid: runGym.uuid, reason: 'closed' });
    const updateGym = (userId: string, input: Record<string, unknown>) =>
      socialGymMutations.updateGym(null, { input: { gymUuid: runGym.uuid, ...input } }, authCtx(userId));

    // The manage form posts every field; an unchanged name and a new description fix nothing.
    await updateGym(GYM_EDITOR, { name: 'Crux', description: 'Bouldering since 2019' });
    expect((await reportRow(wrongDetails.reportUuid)).status).toBe('open');

    await updateGym(GYM_EDITOR, { name: 'Crux', address: '1 Crux Lane' });
    expect(await reportRow(wrongDetails.reportUuid)).toMatchObject({
      status: 'fixed',
      resolvedBy: GYM_EDITOR,
      resolvedByRole: 'gym_staff',
    });
    expect(await noticesFor(REPORTER_A, 'gym_report_resolved')).toHaveLength(1);
    expect((await reportRow(closed.reportUuid)).status).toBe('escalated');
  });

  it('a closure goes to the admin queue', async () => {
    const filed = await reportGym(REPORTER_A, { gymUuid: runGym.uuid, reason: 'closed' });
    expect(filed.routedTo).toEqual(['admin']);
    expect((await reportRow(filed.reportUuid)).status).toBe('escalated');
  });

  it('reportGymDuplicate still emails and now also files a "listed twice" report', async () => {
    const twin = await insertGym(SYSTEM_OWNER, { name: 'Crux (Kilter)' });
    await socialGymReportMutations.reportGymDuplicate(
      null,
      { input: { gymUuid: runGym.uuid, duplicateGymUuid: twin.uuid, note: 'Same building' } },
      authCtx(REPORTER_A),
    );
    const [report] = await db.select().from(dbSchema.directoryReports);
    expect(report).toMatchObject({
      targetKind: 'gym',
      gymId: runGym.id,
      reason: 'duplicate',
      duplicateOfGymId: twin.id,
      status: 'escalated',
    });
  });
});

describe('the sweep', () => {
  const day = 24 * 60 * 60 * 1000;

  async function backdate(reportUuid: string, days: number) {
    await db
      .update(dbSchema.directoryReports)
      .set({ createdAt: new Date(Date.now() - days * day) })
      .where(eq(dbSchema.directoryReports.uuid, reportUuid));
  }

  it('reminds once after seven days', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await backdate(reportUuid, 6);
    expect((await runDirectoryReportSweep()).reminded).toBe(0);
    await backdate(reportUuid, 8);
    expect((await runDirectoryReportSweep()).reminded).toBe(1);
    expect((await runDirectoryReportSweep()).reminded).toBe(0);
    const reminders = (await noticesFor(CREATOR, 'board_report_opened')).filter((notice) => notice.isReminder);
    expect(reminders).toHaveLength(1);
    expect((await reportRow(reportUuid)).remindedAt).not.toBeNull();
  });

  it('moves a report to the admin queue after fourteen days', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await backdate(reportUuid, 15);
    const result = await runDirectoryReportSweep();
    expect(result.escalated).toBe(1);
    expect(result.reminded).toBe(0);
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'escalated' });
  });

  it('closes reports on a board deleted without a hook', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await db
      .update(dbSchema.userBoards)
      .set({ deletedAt: new Date() })
      .where(eq(dbSchema.userBoards.id, climberBoard.id));
    expect((await runDirectoryReportSweep()).closedForVanishedTargets).toBe(1);
    expect(await reportRow(reportUuid)).toMatchObject({ status: 'deleted', resolvedByRole: 'auto' });
  });

  it('sends the digest once a UTC day from 08:00, and none when there is nothing to say', async () => {
    expect(isAdminDigestDue(new Date('2026-11-23T07:59:00Z'), null)).toBe(false);
    expect(isAdminDigestDue(new Date('2026-11-23T08:00:00Z'), '2026-11-22')).toBe(true);
    expect(isAdminDigestDue(new Date('2026-11-23T20:00:00Z'), '2026-11-23')).toBe(false);

    // Two days ago at 09:00 UTC, then the same day at 10:00, then two days ahead.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const at = (dayOffset: number, hour: number) => new Date(today.getTime() + dayOffset * day + hour * 3_600_000);

    const empty = await maybeSendAdminDigest(at(-2, 9));
    expect(empty).toBe('empty');
    expect(sendAdminDailyDigestEmail).not.toHaveBeenCalled();
    expect(await maybeSendAdminDigest(at(-2, 10))).toBe('not_due');

    await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });
    const sent = await maybeSendAdminDigest(at(2, 9));
    expect(sent).toBe('sent');
    const [call] = vi.mocked(sendAdminDailyDigestEmail).mock.calls;
    expect(call[0].sections.map((section) => [section.key, section.total])).toEqual([['escalatedReports', 1]]);
    expect(call[0].sections[0].rows[0].url).toMatch(/\/admin\/board-reports\?report=/);
  });
});

describe('the sweep when something fails', () => {
  const day = 24 * 60 * 60 * 1000;
  const today = () => {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return midnight;
  };
  const at = (dayOffset: number, hour: number) => new Date(today().getTime() + dayOffset * day + hour * 3_600_000);

  it('one report that fails stops neither the others nor the digest', async () => {
    vi.mocked(getJobQueue).mockReturnValue(fakeBoss);
    await registerDevice(CREATOR);
    const secondBoard = await insertBoard(CREATOR, runGym.id);
    const failing = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    const passing = await reportBoard(REPORTER_A, { boardUuid: secondBoard.uuid, reason: 'gone' });
    for (const [reportUuid, days] of [
      [failing.reportUuid, 9],
      [passing.reportUuid, 8],
    ] as const) {
      await db
        .update(dbSchema.directoryReports)
        .set({ createdAt: new Date(Date.now() - days * day) })
        .where(eq(dbSchema.directoryReports.uuid, reportUuid));
    }
    // The older report's reminder push can't be queued, so its reminder rolls back.
    vi.mocked(fakeBoss.send).mockResolvedValueOnce(null);

    const result = await runDirectoryReportSweep(at(0, 9));
    expect(result).toMatchObject({ reminded: 1, failures: 1, digest: 'empty' });
    expect((await reportRow(failing.reportUuid)).remindedAt).toBeNull();
    expect((await reportRow(passing.reportUuid)).remindedAt).not.toBeNull();
  });

  it('a failed send gives the claim back; an email that went out keeps it even when recording it fails', async () => {
    // A digest two days ago starts the window the next ones cover.
    expect(await maybeSendAdminDigest(at(-2, 9))).toBe('empty');
    await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'wrong_place' });

    vi.mocked(sendAdminDailyDigestEmail).mockRejectedValueOnce(new Error('mail server down'));
    expect(await maybeSendAdminDigest(at(2, 9))).toBe('failed');
    expect((await db.select().from(dbSchema.adminDailyDigests)).map((row) => row.status)).toEqual(['empty']);

    vi.mocked(sendAdminDailyDigestEmail).mockImplementationOnce(async () => {
      await db.execute(
        sql`ALTER TABLE "admin_daily_digests" ADD CONSTRAINT "dr_test_no_sent" CHECK ("status"::text <> 'sent') NOT VALID`,
      );
    });
    try {
      expect(await maybeSendAdminDigest(at(2, 10))).toBe('sent');
    } finally {
      await db.execute(sql`ALTER TABLE "admin_daily_digests" DROP CONSTRAINT IF EXISTS "dr_test_no_sent"`);
    }
    // The claim holds the day: no second email.
    expect(await maybeSendAdminDigest(at(2, 11))).toBe('claimed_elsewhere');
    expect(sendAdminDailyDigestEmail).toHaveBeenCalledTimes(2);
    // The next day clears it and covers its window: the report is in it again.
    expect(await maybeSendAdminDigest(at(3, 9))).toBe('sent');
    expect(
      (await db.select().from(dbSchema.adminDailyDigests).orderBy(dbSchema.adminDailyDigests.digestDate)).map((row) => [
        row.digestDate,
        row.status,
      ]),
    ).toEqual([
      [at(-2, 9).toISOString().slice(0, 10), 'empty'],
      [at(3, 9).toISOString().slice(0, 10), 'sent'],
    ]);
  });
});

describe('the directory-reports flag', () => {
  it('off: the report mutations refuse', async () => {
    setFlag(false);
    await expect(reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' })).rejects.toThrow(
      /isn't available yet/,
    );
    await expect(reportGym(REPORTER_A, { gymUuid: runGym.uuid, reason: 'closed' })).rejects.toThrow(
      /isn't available yet/,
    );
  });

  it('off: actions still close reports, but nobody is notified', async () => {
    const { reportUuid } = await reportBoard(REPORTER_A, { boardUuid: climberBoard.uuid, reason: 'gone' });
    await db.execute(sql`TRUNCATE TABLE "notifications" CASCADE`);
    setFlag(false);
    await detach(runGym.uuid, climberBoard.uuid, GYM_OWNER);
    expect((await reportRow(reportUuid)).status).toBe('removed');
    expect(await db.select().from(dbSchema.notifications)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(dbSchema.boardModerationEvents)
        .where(
          and(
            eq(dbSchema.boardModerationEvents.boardId, climberBoard.id),
            eq(dbSchema.boardModerationEvents.action, 'removed_from_gym'),
          ),
        ),
    ).toHaveLength(1);
  });
});
