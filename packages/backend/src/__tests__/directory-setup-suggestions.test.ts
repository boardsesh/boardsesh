import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { boardSetupSummary } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import type {
  BoardSetupChangeConnection,
  BoardSetupInput,
  ConnectionContext,
  DirectoryReport,
  GroupedNotificationConnection,
  UserBoard,
} from '@boardsesh/shared-schema';

vi.mock('../services/analytics/posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/analytics/posthog')>()),
  captureBackendEvent: vi.fn(() => true),
}));

vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  getJobQueue: vi.fn(() => null),
}));

// Wrapped, so one test can make reading the changed board back fail.
vi.mock('../graphql/resolvers/social/boards', async (importOriginal) => {
  const original = await importOriginal<typeof import('../graphql/resolvers/social/boards')>();
  return { ...original, enrichBoard: vi.fn(original.enrichBoard) };
});

import { db } from '../db/client';
import { captureBackendEvent } from '../services/analytics/posthog';
import { getJobQueue } from '../services/job-queue';
import { enrichBoard, updateBoardRecord } from '../graphql/resolvers/social/boards';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { directoryReportMutations, directoryReportQueries } from '../graphql/resolvers/social/directory-reports';
import {
  directorySetupChangePushCopy,
  directorySetupChangePushTarget,
  settleDirectoryNoticePublishes,
} from '../graphql/resolvers/social/directory-reports/notices';
import { ADMIN_DIGEST_SECTION_PROVIDERS, climberSetupChangesSection } from '../services/directory-report-sweep';
import { __resetDirectoryReportsFlagForTests } from '../services/directory-reports-flag';
import { __resetDirectorySetupSuggestionsFlagForTests } from '../services/directory-setup-suggestions-flag';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * A suggested setup on "Set up wrong" (docs/product/directory-reports.md,
 * "Suggested setup"): where it applies and where it waits, what is refused, the
 * limits, what a change writes and who hears about it, undo, the admin list,
 * and the `directory-setup-suggestions` flag.
 *
 * The boards are MoonBoards and Woods boards, whose catalogues live in code, so
 * no Aurora catalogue rows are needed. A MoonBoard doesn't tilt (its angle is
 * part of the setup); the Woods board here does.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CREATOR = 'ss-creator';
const LISTER = 'ss-lister';
const GYM_OWNER = 'ss-gym-owner';
const OPEN_GYM_ADMIN = 'ss-open-gym-admin';
const CLIMBER_A = 'ss-climber-a';
const CLIMBER_B = 'ss-climber-b';
const CLIMBER_C = 'ss-climber-c';
const GLOBAL_ADMIN = 'ss-global-admin';
const OUTSIDER = 'ss-outsider';
const OTHER_OWNER = 'ss-other-owner';
const ALL_USERS = [
  SYSTEM_OWNER,
  CREATOR,
  LISTER,
  GYM_OWNER,
  OPEN_GYM_ADMIN,
  CLIMBER_A,
  CLIMBER_B,
  CLIMBER_C,
  GLOBAL_ADMIN,
  OUTSIDER,
  OTHER_OWNER,
];

/** MoonBoard 2016 (layout 2) has hold sets 2, 3 and 4; MoonBoard 2024 (layout 3) has 5 to 10. One size. */
const ALL_2016_SETS: BoardSetupInput = { layoutId: 2, sizeId: 1, setIds: '4,2,3' };
const MOON_2024_AT_25: BoardSetupInput = { layoutId: 3, sizeId: 1, setIds: '5,6', angle: 25 };
const ONLY_SET_A: BoardSetupInput = { layoutId: 2, sizeId: 1, setIds: '2' };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

type Ref = { id: number; uuid: string };

async function insertGym(ownerId: string, options: { runByGym?: boolean; name: string }): Promise<Ref> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: uuid, name: options.name, ownerId, isPublic: true, latitude: 47, longitude: 8 })
    .returning({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid });
  if (options.runByGym) {
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: ownerId, method: 'admin', status: 'approved' });
  }
  return gym;
}

type BoardOverrides = Partial<{
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
  serialNumber: string;
  latitude: number;
  longitude: number;
  isPublic: boolean;
  syncFrozenAt: Date | null;
}>;

let boardCounter = 0;
/** A MoonBoard 2016 with sets A and B at 40°, each at its own place unless told otherwise. */
async function insertBoard(ownerId: string, gymId: number | null, overrides: BoardOverrides = {}): Promise<Ref> {
  const uuid = uuidv4();
  const place = boardCounter++;
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      name: `Moon ${place}`,
      ownerId,
      boardType: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3',
      angle: 40,
      isAngleAdjustable: false,
      gymId,
      isPublic: true,
      latitude: 40 + place * 0.5,
      longitude: 8,
      ...overrides,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  return board;
}

type SubmitResult = {
  status: string;
  reportUuid: string;
  routedTo: string[];
  otherReporterCount: number;
  setupOutcome: string | null;
  setupReviewReason: string | null;
  board: UserBoard | null;
};

const reportBoard = (userId: string, input: Record<string, unknown>) =>
  directoryReportMutations.reportBoard(null, { input }, authCtx(userId)) as Promise<SubmitResult>;
const suggest = (userId: string, board: Ref, suggestedSetup: BoardSetupInput, extra: Record<string, unknown> = {}) =>
  reportBoard(userId, { boardUuid: board.uuid, reason: 'wrong_setup', suggestedSetup, ...extra });
const undo = (userId: string, eventId: string) =>
  directoryReportMutations.undoBoardSetupChange(null, { eventId }, authCtx(userId)) as Promise<UserBoard>;
const setupChanges = (userId: string, args: Record<string, unknown> = {}) =>
  directoryReportQueries.adminBoardSetupChanges(null, args, authCtx(userId)) as Promise<BoardSetupChangeConnection>;

async function boardRow(board: Ref) {
  const [row] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
  return row;
}

async function reportRow(uuid: string) {
  const [row] = await db.select().from(dbSchema.directoryReports).where(eq(dbSchema.directoryReports.uuid, uuid));
  return row;
}

async function changeEvents(board?: Ref) {
  return db
    .select()
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.action, 'setup_changed_by_climber'),
        board ? eq(dbSchema.boardModerationEvents.boardId, board.id) : undefined,
      ),
    )
    .orderBy(dbSchema.boardModerationEvents.id);
}

async function onlyChangeEventId(board: Ref): Promise<string> {
  const events = await changeEvents(board);
  expect(events).toHaveLength(1);
  return String(events[0].id);
}

async function noticesFor(recipientId: string, type: string) {
  return db
    .select({
      actorId: dbSchema.notifications.actorId,
      entityId: dbSchema.notifications.entityId,
      boardModerationEventId: dbSchema.directoryNotificationContext.boardModerationEventId,
    })
    .from(dbSchema.notifications)
    .leftJoin(
      dbSchema.directoryNotificationContext,
      eq(dbSchema.directoryNotificationContext.notificationUuid, dbSchema.notifications.uuid),
    )
    .where(
      and(eq(dbSchema.notifications.recipientId, recipientId), sql`${dbSchema.notifications.type}::text = ${type}`),
    );
}

/** `reason`: the `extensions.reason` expected, null for none; left out, it isn't checked. */
async function expectRefusal(attempt: Promise<unknown>, code: string, message?: RegExp, reason?: string | null) {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'expected the call to be refused').toBeInstanceOf(Error);
  const extensions = (error as { extensions?: { code?: string; reason?: string } }).extensions;
  expect(extensions?.code).toBe(code);
  if (message) expect((error as Error).message).toMatch(message);
  if (reason !== undefined) expect(extensions?.reason).toBe(reason ?? undefined);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Move every event of this action on this board (or by this actor) back in time. */
async function backdateEvents(
  action: 'setup_changed_by_climber' | 'setup_change_undone',
  ageMs: number,
  scope: { board?: Ref; actorUserId?: string },
) {
  await db
    .update(dbSchema.boardModerationEvents)
    .set({ createdAt: new Date(Date.now() - ageMs) })
    .where(
      and(
        eq(dbSchema.boardModerationEvents.action, action),
        scope.board ? eq(dbSchema.boardModerationEvents.boardId, scope.board.id) : undefined,
        scope.actorUserId ? eq(dbSchema.boardModerationEvents.actorUserId, scope.actorUserId) : undefined,
      ),
    );
}

/** Wait until this many requests in this database are waiting on a lock. */
async function waitForLockWaiters(count: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((row?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Expected ${count} requests waiting on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type HolderTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Hold the board's row `FOR NO KEY UPDATE` in another transaction, start
 * `start` while it is held, wait until `waiters` requests queue on the lock,
 * run `whileHeld` in the holding transaction, then commit and let them through.
 * The requests then run one after the other, in the order they queued.
 */
async function withBoardRowHeld<T>(
  board: Ref,
  waiters: number,
  start: () => T,
  whileHeld?: (holder: HolderTransaction) => Promise<void>,
): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const holder = db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM user_boards WHERE id = ${board.id} FOR NO KEY UPDATE`);
    markLocked();
    await released;
    await whileHeld?.(transaction);
  });
  await locked;
  try {
    const started = start();
    await waitForLockWaiters(waiters);
    return started;
  } finally {
    release();
    await holder;
  }
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
    expiresAt: new Date(Date.now() + DAY_MS),
  });
}

function setFlags(suggestions: boolean) {
  process.env.FEATURE_FLAG_OVERRIDES = suggestions
    ? 'directory-reports,directory-setup-suggestions'
    : 'directory-reports,directory-setup-suggestions=false';
  __resetDirectoryReportsFlagForTests();
  __resetDirectorySetupSuggestionsFlagForTests();
}

let openGym: Ref;
let listedGym: Ref;
let runGym: Ref;
const savedOverrides = process.env.FEATURE_FLAG_OVERRIDES;

beforeEach(async () => {
  resetAllRateLimits();
  setFlags(true);
  vi.mocked(captureBackendEvent).mockClear();
  vi.mocked(getJobQueue).mockReturnValue(null);
  vi.mocked(fakeBoss.send).mockReset();
  vi.mocked(fakeBoss.send).mockResolvedValue('job-id');
  await db.execute(sql`
    TRUNCATE TABLE
      "directory_notification_context", "directory_report_reporters", "directory_reports",
      "notifications", "notification_devices", "resource_privacy", "resource_grants",
      "community_roles", "gym_members", "gym_follows", "gym_claims", "gym_owner_reassignments",
      "board_moderation_events", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: id })))
    .onConflictDoNothing();
  openGym = await insertGym(SYSTEM_OWNER, { name: 'Open Wall' });
  listedGym = await insertGym(LISTER, { name: 'Listed Wall' });
  runGym = await insertGym(GYM_OWNER, { runByGym: true, name: 'Crux' });
  await db.insert(dbSchema.gymMembers).values([{ gymId: openGym.id, userId: OPEN_GYM_ADMIN, role: 'admin' }]);
  await db.insert(dbSchema.communityRoles).values([{ userId: GLOBAL_ADMIN, role: 'admin', boardType: null }]);
});

afterEach(() => {
  if (savedOverrides === undefined) delete process.env.FEATURE_FLAG_OVERRIDES;
  else process.env.FEATURE_FLAG_OVERRIDES = savedOverrides;
  __resetDirectoryReportsFlagForTests();
  __resetDirectorySetupSuggestionsFlagForTests();
});

afterAll(async () => {
  await settleDirectoryNoticePublishes();
});

describe('a suggestion at a gym nobody runs changes the board', () => {
  it('at an unclaimed gym: the board changes, the report closes as fixed by a climber, the sync is frozen out', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ status: 'created', setupOutcome: 'APPLIED', setupReviewReason: null });
    expect(result.board).toMatchObject({ uuid: board.uuid, layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 });

    const row = await boardRow(board);
    expect(row).toMatchObject({ layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 });
    expect(row.syncFrozenAt).not.toBeNull();

    const report = await reportRow(result.reportUuid);
    expect(report).toMatchObject({ status: 'fixed', resolvedByRole: 'climber', resolvedBy: CLIMBER_A });
    const [reporter] = await db.select().from(dbSchema.directoryReportReporters);
    expect(reporter.suggestedSetup).toEqual({ layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: null });

    const [event] = await changeEvents(board);
    expect(event).toMatchObject({
      actorUserId: CLIMBER_A,
      actorRole: 'climber',
      gymId: openGym.id,
      details: {
        before: { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 40 },
        after: { layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 },
        reportUuid: result.reportUuid,
      },
    });
    expect(captureBackendEvent).toHaveBeenCalledWith('Board Setup Suggested', {
      properties: { outcome: 'APPLIED', reason: null, boardType: 'moonboard', gymState: 'UNCLAIMED' },
    });
  });

  it('at a climber-listed gym, the angle of a board that does not tilt included', async () => {
    const board = await insertBoard(CREATOR, listedGym.id);
    const result = await suggest(CLIMBER_A, board, MOON_2024_AT_25);
    expect(result.setupOutcome).toBe('APPLIED');
    expect(await boardRow(board)).toMatchObject({ layoutId: 3, setIds: '5,6', angle: 25 });
    const [event] = await changeEvents(board);
    expect(event.details?.after).toEqual({ layoutId: 3, sizeId: 1, setIds: '5,6', angle: 25 });
    expect(captureBackendEvent).toHaveBeenCalledWith('Board Setup Suggested', {
      properties: { outcome: 'APPLIED', reason: null, boardType: 'moonboard', gymState: 'CLIMBER_LISTED' },
    });
  });

  it('on a board that tilts, the angle is not part of the setup and stays as it was', async () => {
    const board = await insertBoard(CREATOR, openGym.id, {
      boardType: 'woods',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      isAngleAdjustable: true,
    });
    const result = await suggest(CLIMBER_A, board, { layoutId: 1, sizeId: 2, setIds: '1', angle: 30 });
    expect(result.setupOutcome).toBe('APPLIED');
    expect(await boardRow(board)).toMatchObject({ sizeId: 2, angle: 40 });
    const [reporter] = await db.select().from(dbSchema.directoryReportReporters);
    expect(reporter.suggestedSetup).toEqual({ layoutId: 1, sizeId: 2, setIds: '1', angle: null });
    const [event] = await changeEvents(board);
    expect(event.details).toMatchObject({ before: { sizeId: 1, angle: null }, after: { sizeId: 2, angle: null } });
  });
});

describe('a suggestion that goes to review', () => {
  it('at a gym run by the gym: CLAIMED_GYM, and staff read the suggestion without the reporter', async () => {
    const board = await insertBoard(CREATOR, runGym.id);
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({
      status: 'created',
      setupOutcome: 'SENT_FOR_REVIEW',
      setupReviewReason: 'CLAIMED_GYM',
      board: null,
    });
    expect(await boardRow(board)).toMatchObject({ setIds: '2,3', syncFrozenAt: null });
    expect((await reportRow(result.reportUuid)).status).toBe('open');
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(1);
    expect(await changeEvents()).toHaveLength(0);

    const [staffView] = (await directoryReportQueries.boardReports(
      null,
      { boardUuid: board.uuid },
      authCtx(GYM_OWNER),
    )) as DirectoryReport[];
    expect(staffView.notes).toEqual([
      expect.objectContaining({
        note: '',
        reporter: null,
        suggestedSetup: { layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: null },
      }),
    ]);
    const [adminView] = (await directoryReportQueries.boardReports(
      null,
      { boardUuid: board.uuid },
      authCtx(GLOBAL_ADMIN),
    )) as DirectoryReport[];
    expect(adminView.notes[0].reporter?.userId).toBe(CLIMBER_A);
    expect(captureBackendEvent).toHaveBeenCalledWith('Board Setup Suggested', {
      properties: { outcome: 'SENT_FOR_REVIEW', reason: 'CLAIMED_GYM', boardType: 'moonboard', gymState: 'RUN_BY_GYM' },
    });
  });

  it('with no gym: NO_GYM, to the creator', async () => {
    const board = await insertBoard(CREATOR, null);
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS, { note: 'Sets C is up too' });
    expect(result).toMatchObject({
      setupOutcome: 'SENT_FOR_REVIEW',
      setupReviewReason: 'NO_GYM',
      routedTo: ['creator'],
    });
    expect((await boardRow(board)).setIds).toBe('2,3');
    const [creatorView] = (await directoryReportQueries.boardReports(
      null,
      { boardUuid: board.uuid },
      authCtx(CREATOR),
    )) as DirectoryReport[];
    expect(creatorView.notes[0]).toMatchObject({ note: 'Sets C is up too', suggestedSetup: { setIds: '2,3,4' } });
  });

  it('with the directory-setup-suggestions flag off: stored, sent for review with no reason', async () => {
    setFlags(false);
    const board = await insertBoard(CREATOR, openGym.id);
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: null, board: null });
    expect((await boardRow(board)).setIds).toBe('2,3');
    const [reporter] = await db.select().from(dbSchema.directoryReportReporters);
    expect(reporter.suggestedSetup).toEqual({ layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: null });
    expect(await changeEvents()).toHaveLength(0);
  });

  it('a report without a suggestion has no setup outcome', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const result = await reportBoard(CLIMBER_A, { boardUuid: board.uuid, reason: 'wrong_setup' });
    expect(result).toMatchObject({ setupOutcome: null, setupReviewReason: null, board: null });
  });
});

describe('a suggestion that is refused, never sent to review', () => {
  it('refuses an unknown layout, size or sets, an unsupported angle, and the setup the board has now', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const refusals: Array<[BoardSetupInput, RegExp, string | null]> = [
      [{ layoutId: 99, sizeId: 1, setIds: '2' }, /don't go together/, null],
      [{ layoutId: 2, sizeId: 2, setIds: '2' }, /don't go together/, null],
      [{ layoutId: 2, sizeId: 1, setIds: '5' }, /don't go together/, null],
      [{ layoutId: 2, sizeId: 1, setIds: '2,4', angle: -5 }, /angle/, null],
      // A routable angle no Angle row offers.
      [{ layoutId: 2, sizeId: 1, setIds: '2,4', angle: 33 }, /angle/, null],
      [{ layoutId: 2, sizeId: 1, setIds: '3,2' }, /has now/, 'SETUP_UNCHANGED'],
      [{ layoutId: 2, sizeId: 1, setIds: '2,3', angle: 40 }, /has now/, 'SETUP_UNCHANGED'],
    ];
    for (const [suggestedSetup, message, reason] of refusals) {
      // Reports are rate limited to 5 a minute per climber.
      resetAllRateLimits();
      // Only "the setup it has now" carries a reason, so clients can tell it apart.
      await expectRefusal(suggest(CLIMBER_A, board, suggestedSetup), 'BAD_USER_INPUT', message, reason);
    }
    expect(await db.select().from(dbSchema.directoryReports)).toHaveLength(0);
  });

  it('takes an angle the board type offers, the MoonBoard wide range included', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const result = await suggest(CLIMBER_A, board, { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 30 });
    expect(result.setupOutcome).toBe('APPLIED');
    expect((await boardRow(board)).angle).toBe(30);
  });

  it("never refuses the board's own angle, even one no Angle row offers, when only the layout changed", async () => {
    const offStep = await insertBoard(CREATOR, openGym.id, { angle: 42 });
    const result = await suggest(CLIMBER_A, offStep, { ...MOON_2024_AT_25, angle: 42 });
    expect(result.setupOutcome).toBe('APPLIED');
    expect(await boardRow(offStep)).toMatchObject({ layoutId: 3, setIds: '5,6', angle: 42 });
  });

  it('refuses a suggestion on a board the reporter cannot read: not found, nothing filed', async () => {
    const privateBoard = await insertBoard(CREATOR, openGym.id, { isPublic: false });
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'board', resourceId: privateBoard.uuid, ownerId: CREATOR, audience: 'invite_only' });
    await expectRefusal(suggest(CLIMBER_A, privateBoard, ALL_2016_SETS), 'NOT_FOUND');
    expect(await db.select().from(dbSchema.directoryReports)).toHaveLength(0);
    expect((await boardRow(privateBoard)).setIds).toBe('2,3');
  });

  it('refuses a suggestion once the board turns private while it waits for the row lock', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const [outcome] = await withBoardRowHeld(
      board,
      1,
      () => Promise.allSettled([suggest(CLIMBER_A, board, ALL_2016_SETS)]),
      async (holder) => {
        await holder.update(dbSchema.userBoards).set({ isPublic: false }).where(eq(dbSchema.userBoards.id, board.id));
        await holder
          .insert(dbSchema.resourcePrivacy)
          .values({ kind: 'board', resourceId: board.uuid, ownerId: CREATOR, audience: 'invite_only' });
      },
    );
    expect(outcome.status).toBe('rejected');
    expect(((outcome as PromiseRejectedResult).reason as { extensions?: { code?: string } }).extensions?.code).toBe(
      'NOT_FOUND',
    );
    expect(await db.select().from(dbSchema.directoryReports)).toHaveLength(0);
    expect((await boardRow(board)).setIds).toBe('2,3');
  });

  it('refuses a suggestion on a spray wall and with any reason but "set up wrong"', async () => {
    const spray = await insertBoard(CREATOR, openGym.id, { boardType: 'spray' });
    await expectRefusal(suggest(CLIMBER_A, spray, ALL_2016_SETS), 'BAD_USER_INPUT', /suggest a setup/);
    const board = await insertBoard(CREATOR, openGym.id);
    await expectRefusal(
      reportBoard(CLIMBER_A, { boardUuid: board.uuid, reason: 'gone', suggestedSetup: ALL_2016_SETS }),
      'BAD_USER_INPUT',
      /suggest a setup/,
    );
    expect(await db.select().from(dbSchema.directoryReports)).toHaveLength(0);
  });
});

describe('the limits send a suggestion to review', () => {
  it('a second climber change to one board within 24 hours: RECENT_CHANGE', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    expect((await suggest(CLIMBER_A, board, ALL_2016_SETS)).setupOutcome).toBe('APPLIED');
    const second = await suggest(CLIMBER_B, board, MOON_2024_AT_25);
    expect(second).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'RECENT_CHANGE' });
    expect((await boardRow(board)).setIds).toBe('2,3,4');
  });

  it('for 90 days after an undo: RECENTLY_UNDONE, and the reporter may file again straight away', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const applied = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    await undo(GLOBAL_ADMIN, await onlyChangeEventId(board));

    const again = await suggest(CLIMBER_A, board, MOON_2024_AT_25);
    expect(again).toMatchObject({
      status: 'created',
      setupOutcome: 'SENT_FOR_REVIEW',
      setupReviewReason: 'RECENTLY_UNDONE',
    });
    expect(again.reportUuid).not.toBe(applied.reportUuid);
    expect((await boardRow(board)).setIds).toBe('2,3');
  });

  it("a climber's 3 changes in 24 hours, on any boards: DAILY_LIMIT", async () => {
    const boards = [
      await insertBoard(CREATOR, openGym.id),
      await insertBoard(CREATOR, openGym.id),
      await insertBoard(SYSTEM_OWNER, openGym.id),
      await insertBoard(CREATOR, listedGym.id),
    ];
    for (const board of boards.slice(0, 3)) {
      expect((await suggest(CLIMBER_A, board, ALL_2016_SETS)).setupOutcome).toBe('APPLIED');
    }
    const fourth = await suggest(CLIMBER_A, boards[3], ALL_2016_SETS);
    expect(fourth).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'DAILY_LIMIT' });
    // Another climber is not held back by it.
    expect((await suggest(CLIMBER_B, boards[3], MOON_2024_AT_25)).setupOutcome).toBe('APPLIED');
  });

  it("a copy of another of the owner's boards at the same place: CLASHES", async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const { latitude, longitude } = await boardRow(board);
    await insertBoard(CREATOR, null, { setIds: '2,3,4', latitude: latitude ?? 0, longitude: longitude ?? 0 });
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'CLASHES', board: null });
    expect((await boardRow(board)).setIds).toBe('2,3');
    expect((await reportRow(result.reportUuid)).status).toBe('open');
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(1);
  });

  it("another owner's board with the same serial and the new setup: CLASHES", async () => {
    const board = await insertBoard(CREATOR, openGym.id, { serialNumber: 'MOON-SERIAL-1' });
    await insertBoard(OTHER_OWNER, null, { setIds: '2,3,4', serialNumber: 'MOON-SERIAL-1' });
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'CLASHES' });
    expect((await boardRow(board)).setIds).toBe('2,3');
  });

  it('two suggestions queued on the board row lock together: the first applies, the second reads it and waits', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    // Both pass their checks before the filing transaction, then queue on the
    // board row, which another transaction holds, and go one at a time.
    const settled = await withBoardRowHeld(board, 2, () =>
      Promise.allSettled([suggest(CLIMBER_A, board, ALL_2016_SETS), suggest(CLIMBER_B, board, MOON_2024_AT_25)]),
    );
    const results = settled.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    const outcomes = results.map((result) => [result.setupOutcome, result.setupReviewReason]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ['APPLIED', null],
        ['SENT_FOR_REVIEW', 'RECENT_CHANGE'],
      ]),
    );
    expect(await changeEvents(board)).toHaveLength(1);
    const applied = results.find((result) => result.setupOutcome === 'APPLIED');
    expect((await boardRow(board)).setIds).toBe(applied?.board?.setIds);
  });
});

describe('the limits lift once their windows pass', () => {
  it('a board changed 25 hours ago takes a climber change again', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    expect((await suggest(CLIMBER_A, board, ALL_2016_SETS)).setupOutcome).toBe('APPLIED');
    await backdateEvents('setup_changed_by_climber', 25 * HOUR_MS, { board });
    const later = await suggest(CLIMBER_B, board, MOON_2024_AT_25);
    expect(later).toMatchObject({ setupOutcome: 'APPLIED', setupReviewReason: null });
    expect((await boardRow(board)).layoutId).toBe(3);
  });

  it('91 days after an undo, a suggestion applies again', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    await undo(CREATOR, await onlyChangeEventId(board));
    await backdateEvents('setup_changed_by_climber', 92 * DAY_MS, { board });
    await backdateEvents('setup_change_undone', 91 * DAY_MS, { board });
    expect((await suggest(CLIMBER_B, board, MOON_2024_AT_25)).setupOutcome).toBe('APPLIED');
  });

  it("a climber's fourth change applies once their earlier three are past the 24-hour window", async () => {
    const boards = [
      await insertBoard(CREATOR, openGym.id),
      await insertBoard(CREATOR, openGym.id),
      await insertBoard(CREATOR, openGym.id),
      await insertBoard(CREATOR, listedGym.id),
    ];
    for (const board of boards.slice(0, 3)) await suggest(CLIMBER_A, board, ALL_2016_SETS);
    await backdateEvents('setup_changed_by_climber', 25 * HOUR_MS, { actorUserId: CLIMBER_A });
    expect((await suggest(CLIMBER_A, boards[3], ALL_2016_SETS)).setupOutcome).toBe('APPLIED');
  });
});

describe('a climber change someone put back by hand counts as an undo', () => {
  it('the board edited back sends the next suggestion to review as RECENTLY_UNDONE, for 90 days', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    // The creator edits it back instead of using Undo.
    await updateBoardRecord({ boardUuid: board.uuid, setIds: '2,3' }, authCtx(CREATOR));
    await backdateEvents('setup_changed_by_climber', 2 * DAY_MS, { board });
    const next = await suggest(CLIMBER_B, board, MOON_2024_AT_25);
    expect(next).toMatchObject({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'RECENTLY_UNDONE' });
    expect((await boardRow(board)).setIds).toBe('2,3');

    // 91 days after the change, the board takes climber changes again.
    await backdateEvents('setup_changed_by_climber', 91 * DAY_MS, { board });
    expect((await suggest(CLIMBER_C, board, ONLY_SET_A)).setupOutcome).toBe('APPLIED');
  });

  it('within the first day it is RECENTLY_UNDONE too, not RECENT_CHANGE', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    await updateBoardRecord({ boardUuid: board.uuid, setIds: '2' }, authCtx(CREATOR));
    expect(await suggest(CLIMBER_B, board, MOON_2024_AT_25)).toMatchObject({
      setupOutcome: 'SENT_FOR_REVIEW',
      setupReviewReason: 'RECENTLY_UNDONE',
    });
  });

  it('a board that still has the change is not counted as overridden', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    // A name edit leaves the setup as the climber made it.
    await updateBoardRecord({ boardUuid: board.uuid, name: 'Moon at the back' }, authCtx(CREATOR));
    await backdateEvents('setup_changed_by_climber', 25 * HOUR_MS, { board });
    expect((await suggest(CLIMBER_B, board, MOON_2024_AT_25)).setupOutcome).toBe('APPLIED');
  });
});

describe('reporting again after a climber changed the board', () => {
  it("skips the 7-day cooldown for everyone on the report; the board's 24 hours send a repeat to review", async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const first = await reportBoard(CLIMBER_B, { boardUuid: board.uuid, reason: 'wrong_setup', note: 'sets are off' });
    await reportBoard(CLIMBER_C, { boardUuid: board.uuid, reason: 'wrong_setup' });
    const applied = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(applied).toMatchObject({ reportUuid: first.reportUuid, setupOutcome: 'APPLIED' });
    expect(await reportRow(first.reportUuid)).toMatchObject({ status: 'fixed', resolvedByRole: 'climber' });

    const again = await suggest(CLIMBER_B, board, MOON_2024_AT_25);
    expect(again).toMatchObject({
      status: 'created',
      setupOutcome: 'SENT_FOR_REVIEW',
      setupReviewReason: 'RECENT_CHANGE',
    });
    expect(again.reportUuid).not.toBe(first.reportUuid);
    expect((await reportRow(again.reportUuid)).status).toBe('open');
    expect((await boardRow(board)).setIds).toBe('2,3,4');

    // The climber who made the change may file again too; they join the new report.
    const actorAgain = await suggest(CLIMBER_A, board, ONLY_SET_A);
    expect(actorAgain).toMatchObject({ status: 'added', reportUuid: again.reportUuid });
  });

  it('keeps the cooldown when someone else fixed the report', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const first = await reportBoard(CLIMBER_B, { boardUuid: board.uuid, reason: 'wrong_setup' });
    await updateBoardRecord({ boardUuid: board.uuid, setIds: '2' }, authCtx(CREATOR));
    expect((await reportRow(first.reportUuid)).resolvedByRole).toBe('creator');
    const again = await suggest(CLIMBER_B, board, ALL_2016_SETS);
    expect(again).toMatchObject({ status: 'already_reported', reportUuid: first.reportUuid, setupOutcome: null });
  });
});

describe('who hears about a change', () => {
  it('other reporters hear it fixed, the climber who made it does not, the creator and gym admin hear the change', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const earlier = await reportBoard(CLIMBER_B, {
      boardUuid: board.uuid,
      reason: 'wrong_setup',
      note: 'sets are off',
    });
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ status: 'added', reportUuid: earlier.reportUuid, setupOutcome: 'APPLIED' });

    expect(await noticesFor(CLIMBER_B, 'board_report_resolved')).toHaveLength(1);
    expect(await noticesFor(CLIMBER_A, 'board_report_resolved')).toHaveLength(0);
    const eventId = await onlyChangeEventId(board);
    const [creatorNotice] = await noticesFor(CREATOR, 'board_setup_changed_by_climber');
    expect(creatorNotice).toEqual({ actorId: null, entityId: board.uuid, boardModerationEventId: Number(eventId) });
    expect(await noticesFor(OPEN_GYM_ADMIN, 'board_setup_changed_by_climber')).toEqual([creatorNotice]);

    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(CREATOR),
    )) as GroupedNotificationConnection;
    const group = feed.groups.find((candidate) => candidate.type === 'board_setup_changed_by_climber');
    expect(group?.actors).toEqual([]);
    expect(group?.directoryNotice).toMatchObject({
      boardUuid: board.uuid,
      gymName: 'Open Wall',
      recipientIsCreator: true,
      setupChangeEventId: eventId,
      setupBefore: { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 40 },
      setupAfter: { layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 },
      setupChangeState: 'LIVE',
    });

    await undo(CREATOR, eventId);
    const afterUndo = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(CREATOR),
    )) as GroupedNotificationConnection;
    expect(
      afterUndo.groups.find((candidate) => candidate.type === 'board_setup_changed_by_climber')?.directoryNotice
        ?.setupChangeState,
    ).toBe('UNDONE');
  });

  it('a report the change closes at once tells nobody it opened', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(await noticesFor(CREATOR, 'board_report_opened')).toHaveLength(0);
    expect(await noticesFor(CREATOR, 'board_setup_changed_by_climber')).toHaveLength(1);
  });

  it("a synced board has no creator to tell; its gym's admins hear", async () => {
    const board = await insertBoard(SYSTEM_OWNER, openGym.id);
    expect((await suggest(CLIMBER_A, board, ALL_2016_SETS)).setupOutcome).toBe('APPLIED');
    const notices = await db.select().from(dbSchema.notifications);
    expect(notices.map((notice) => [notice.recipientId, notice.type])).toEqual([
      [OPEN_GYM_ADMIN, 'board_setup_changed_by_climber'],
    ]);
  });

  it("the gym's owner and admins hear, worded as staff, and every recipient may undo it", async () => {
    const board = await insertBoard(CREATOR, listedGym.id);
    await db.insert(dbSchema.gymMembers).values([{ gymId: listedGym.id, userId: OUTSIDER, role: 'editor' }]);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const eventId = await onlyChangeEventId(board);
    expect(await noticesFor(CREATOR, 'board_setup_changed_by_climber')).toHaveLength(1);
    expect(await noticesFor(LISTER, 'board_setup_changed_by_climber')).toHaveLength(1);
    // An editor may not undo, so isn't told.
    expect(await noticesFor(OUTSIDER, 'board_setup_changed_by_climber')).toHaveLength(0);
    expect(await noticesFor(CLIMBER_A, 'board_setup_changed_by_climber')).toHaveLength(0);

    const feed = (await socialNotificationQueries.groupedNotifications(
      null,
      { limit: 20 },
      authCtx(LISTER),
    )) as GroupedNotificationConnection;
    expect(feed.groups.find((group) => group.type === 'board_setup_changed_by_climber')?.directoryNotice).toMatchObject(
      {
        recipientIsCreator: false,
        gymName: 'Listed Wall',
        setupChangeEventId: eventId,
        setupChangeState: 'LIVE',
      },
    );
    expect((await undo(LISTER, eventId)).setIds).toBe('2,3');
  });

  it('the gym admin who made the change hears nothing; the creator does', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(OPEN_GYM_ADMIN, board, ALL_2016_SETS);
    expect(await noticesFor(OPEN_GYM_ADMIN, 'board_setup_changed_by_climber')).toHaveLength(0);
    expect(await noticesFor(CREATOR, 'board_setup_changed_by_climber')).toHaveLength(1);
  });

  it('a creator suggesting on their own board acts as its owner, and only the gym hears', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const result = await suggest(CREATOR, board, ALL_2016_SETS);
    expect(result.setupOutcome).toBe('APPLIED');
    const [event] = await changeEvents(board);
    expect(event).toMatchObject({ actorUserId: CREATOR, actorRole: 'board_owner' });
    expect(await reportRow(result.reportUuid)).toMatchObject({ status: 'fixed', resolvedByRole: 'creator' });
    expect(await noticesFor(CREATOR, 'board_setup_changed_by_climber')).toHaveLength(0);
    expect(await noticesFor(OPEN_GYM_ADMIN, 'board_setup_changed_by_climber')).toHaveLength(1);
  });

  it('pushes the change to each recipient, rechecked until it is undone', async () => {
    vi.mocked(getJobQueue).mockReturnValue(fakeBoss);
    await registerDevice(CREATOR);
    await registerDevice(OPEN_GYM_ADMIN);
    await registerDevice(CLIMBER_A);
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const deliveries = await db
      .select({
        recipientId: dbSchema.notificationDeliveries.recipientId,
        notificationUuid: dbSchema.notificationDeliveries.notificationUuid,
      })
      .from(dbSchema.notificationDeliveries);
    expect(deliveries.map((delivery) => delivery.recipientId).sort()).toEqual([CREATOR, OPEN_GYM_ADMIN].sort());
    expect(fakeBoss.send).toHaveBeenCalledTimes(2);

    const eventId = await onlyChangeEventId(board);
    const creatorDelivery = deliveries.find((delivery) => delivery.recipientId === CREATOR);
    const target = await directorySetupChangePushTarget(creatorDelivery!.notificationUuid);
    expect(target).toEqual({
      recipientId: CREATOR,
      boardUuid: board.uuid,
      boardName: (await boardRow(board)).name,
      setupChangeEventId: eventId,
    });
    expect(directorySetupChangePushCopy('en-US', { boardName: 'Moon 1' })).toEqual({
      title: 'A climber changed the setup of Moon 1',
      body: "Check the new setup, and undo it if it's wrong.",
    });

    // Nothing to undo once it is undone: the push is skipped.
    await undo(GLOBAL_ADMIN, eventId);
    expect(await directorySetupChangePushTarget(creatorDelivery!.notificationUuid)).toBeNull();
  });
});

describe('a reporter already on the waiting report', () => {
  it('replaces their suggestion with the new one', async () => {
    const board = await insertBoard(CREATOR, runGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const again = await suggest(CLIMBER_A, board, MOON_2024_AT_25);
    expect(again).toMatchObject({ status: 'already_reported', setupOutcome: 'SENT_FOR_REVIEW' });
    const reporters = await db.select().from(dbSchema.directoryReportReporters);
    expect(reporters).toHaveLength(1);
    expect(reporters[0].suggestedSetup).toEqual({ layoutId: 3, sizeId: 1, setIds: '5,6', angle: 25 });
  });
});

describe('undoBoardSetupChange', () => {
  it('puts the old setup and its sync freeze back, leaves the report closed, and does it once', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    const applied = await suggest(CLIMBER_A, board, MOON_2024_AT_25);
    const eventId = await onlyChangeEventId(board);
    const frozenByChange = (await boardRow(board)).syncFrozenAt;
    expect(frozenByChange).not.toBeNull();
    expect((await changeEvents(board))[0].details).toMatchObject({
      syncFrozenAtBefore: null,
      syncFrozenAtSet: frozenByChange?.toISOString(),
    });

    const restored = await undo(CREATOR, eventId);
    expect(restored).toMatchObject({ uuid: board.uuid, layoutId: 2, setIds: '2,3', angle: 40 });
    const row = await boardRow(board);
    expect(row).toMatchObject({ layoutId: 2, setIds: '2,3', angle: 40 });
    // The board wasn't frozen before the change, so the sync may update it again.
    expect(row.syncFrozenAt).toBeNull();
    expect((await reportRow(applied.reportUuid)).status).toBe('fixed');

    const [undone] = await db
      .select()
      .from(dbSchema.boardModerationEvents)
      .where(eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'));
    expect(undone).toMatchObject({
      actorUserId: CREATOR,
      actorRole: 'board_owner',
      details: {
        before: { layoutId: 3, setIds: '5,6', angle: 25 },
        after: { layoutId: 2, setIds: '2,3', angle: 40 },
        undoesEventId: Number(eventId),
      },
    });
    expect(captureBackendEvent).toHaveBeenCalledWith('Board Setup Change Undone', { properties: { by: 'creator' } });

    await expectRefusal(undo(CREATOR, eventId), 'BOARD_SETUP_ALREADY_UNDONE');
  });

  it('puts back a freeze the board had before the change', async () => {
    const frozenEarlier = new Date('2026-10-01T08:30:00.000Z');
    const board = await insertBoard(CREATOR, openGym.id, { syncFrozenAt: frozenEarlier });
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect((await changeEvents(board))[0].details?.syncFrozenAtBefore).toBe(frozenEarlier.toISOString());
    await undo(CREATOR, await onlyChangeEventId(board));
    expect((await boardRow(board)).syncFrozenAt?.toISOString()).toBe(frozenEarlier.toISOString());
  });

  it('keeps a freeze written since the change: the board stays frozen', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    // An edit that leaves the setup alone (a name, a place) freezes the board again.
    const frozenSince = new Date(Date.now() + 60_000);
    await db.update(dbSchema.userBoards).set({ syncFrozenAt: frozenSince }).where(eq(dbSchema.userBoards.id, board.id));
    await undo(CREATOR, await onlyChangeEventId(board));
    expect((await boardRow(board)).syncFrozenAt?.toISOString()).toBe(frozenSince.toISOString());
  });

  it('two undos at once: exactly one puts it back, the other reads BOARD_SETUP_ALREADY_UNDONE', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const eventId = await onlyChangeEventId(board);
    const settled = await withBoardRowHeld(board, 2, () =>
      Promise.allSettled([undo(CREATOR, eventId), undo(GLOBAL_ADMIN, eventId)]),
    );
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const [refused] = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect((refused.reason as { extensions?: { code?: string } }).extensions?.code).toBe('BOARD_SETUP_ALREADY_UNDONE');
    const undos = await db
      .select()
      .from(dbSchema.boardModerationEvents)
      .where(eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'));
    expect(undos).toHaveLength(1);
    expect((await boardRow(board)).setIds).toBe('2,3');
  });

  it("the staff of the gym the board moved to may undo; the old gym's staff may not", async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const eventId = await onlyChangeEventId(board);
    await db.update(dbSchema.userBoards).set({ gymId: listedGym.id }).where(eq(dbSchema.userBoards.id, board.id));
    await expectRefusal(undo(OPEN_GYM_ADMIN, eventId), 'NOT_FOUND');
    expect((await undo(LISTER, eventId)).setIds).toBe('2,3');
    const [undone] = await db
      .select()
      .from(dbSchema.boardModerationEvents)
      .where(eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'));
    expect(undone).toMatchObject({ actorUserId: LISTER, actorRole: 'gym_owner', gymId: listedGym.id });
  });

  it('refuses once the board has changed since (compare-and-set)', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    await suggest(CLIMBER_A, board, ALL_2016_SETS);
    const eventId = await onlyChangeEventId(board);
    await updateBoardRecord({ boardUuid: board.uuid, setIds: '2' }, authCtx(CREATOR));
    await expectRefusal(undo(GLOBAL_ADMIN, eventId), 'BOARD_SETUP_CHANGED_SINCE');
    expect((await boardRow(board)).setIds).toBe('2');
  });

  it("the creator, the gym's staff and a global admin may undo; anyone else, the climber included, reads not found", async () => {
    const undoers: Array<[string, string, string, string]> = [
      [CREATOR, 'board_owner', 'creator', CLIMBER_A],
      [OPEN_GYM_ADMIN, 'gym_admin', 'gym_staff', CLIMBER_B],
      [GLOBAL_ADMIN, 'global_admin', 'admin', CLIMBER_C],
    ];
    for (const [undoer, actorRole, by, climber] of undoers) {
      const board = await insertBoard(CREATOR, openGym.id);
      await suggest(climber, board, ONLY_SET_A);
      const eventId = await onlyChangeEventId(board);
      // LISTER runs another gym; the climber who made the change has no say over it either.
      for (const stranger of [OUTSIDER, climber, LISTER]) {
        await expectRefusal(undo(stranger, eventId), 'NOT_FOUND');
      }
      const restored = await undo(undoer, eventId);
      expect(restored.setIds).toBe('2,3');
      const [undone] = await db
        .select()
        .from(dbSchema.boardModerationEvents)
        .where(
          and(
            eq(dbSchema.boardModerationEvents.boardId, board.id),
            eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'),
          ),
        );
      expect(undone).toMatchObject({ actorUserId: undoer, actorRole });
      expect(captureBackendEvent).toHaveBeenCalledWith('Board Setup Change Undone', { properties: { by } });
    }
  });

  it('an id that is not a climber setup change reads not found', async () => {
    await expectRefusal(undo(GLOBAL_ADMIN, '424242'), 'NOT_FOUND');
  });
});

describe('a change that applied but could not be read back', () => {
  it('still says APPLIED, with board null, so the client refetches the board', async () => {
    const board = await insertBoard(CREATOR, openGym.id);
    vi.mocked(enrichBoard).mockRejectedValueOnce(new Error('read failed'));
    const result = await suggest(CLIMBER_A, board, ALL_2016_SETS);
    expect(result).toMatchObject({ setupOutcome: 'APPLIED', setupReviewReason: null, board: null });
    expect((await boardRow(board)).setIds).toBe('2,3,4');
  });
});

describe("the admin's daily digest", () => {
  it('lists the setups climbers changed in the window, newest first, with before → after and the tab link', async () => {
    const first = await insertBoard(CREATOR, openGym.id);
    const second = await insertBoard(SYSTEM_OWNER, listedGym.id);
    await suggest(CLIMBER_A, first, ALL_2016_SETS);
    await suggest(CLIMBER_B, second, MOON_2024_AT_25);
    await undo(GLOBAL_ADMIN, await onlyChangeEventId(first));

    expect(ADMIN_DIGEST_SECTION_PROVIDERS).toContain(climberSetupChangesSection);
    const window = { start: new Date(Date.now() - DAY_MS), end: new Date(Date.now() + 1000) };
    const section = await climberSetupChangesSection(window);
    const before = (setIds: string) => boardSetupSummary('moonboard', { layoutId: 2, sizeId: 1, setIds, angle: 40 });
    expect(section).toMatchObject({ key: 'climberSetupChanges', total: 2 });
    expect(section?.moreUrl).toMatch(/\/admin\/board-reports\?tab=setup-changes$/);
    expect(section?.rows.map((row) => row.label)).toEqual([
      `${(await boardRow(second)).name} at Listed Wall: ${before('2,3')} → ${boardSetupSummary('moonboard', MOON_2024_AT_25)}`,
      `${(await boardRow(first)).name} at Open Wall: ${before('2,3')} → ${before('2,3,4')} (already undone)`,
    ]);
    expect(section?.rows.every((row) => row.url === section.moreUrl)).toBe(true);

    expect(await climberSetupChangesSection({ start: new Date(Date.now() + 1000), end: new Date() })).toBeNull();
  });

  it('lists at most ten rows and counts the rest', async () => {
    for (let index = 0; index < 12; index += 1) {
      const board = await insertBoard(SYSTEM_OWNER, openGym.id);
      await db.insert(dbSchema.boardModerationEvents).values({
        boardId: board.id,
        gymId: openGym.id,
        actorUserId: CLIMBER_A,
        actorRole: 'climber',
        action: 'setup_changed_by_climber',
        details: {
          before: { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 40 },
          after: { layoutId: 2, sizeId: 1, setIds: '2', angle: 40 },
        },
      });
    }
    const section = await climberSetupChangesSection({
      start: new Date(Date.now() - DAY_MS),
      end: new Date(Date.now() + 1000),
    });
    expect(section?.total).toBe(12);
    expect(section?.rows).toHaveLength(10);
  });
});

describe('adminBoardSetupChanges', () => {
  it('lists every change newest first, with the climber and where it stands; admins only', async () => {
    const first = await insertBoard(CREATOR, openGym.id);
    const second = await insertBoard(CREATOR, listedGym.id);
    await suggest(CLIMBER_A, first, ALL_2016_SETS);
    await suggest(CLIMBER_B, second, MOON_2024_AT_25);
    await undo(GLOBAL_ADMIN, await onlyChangeEventId(first));

    const page = await setupChanges(GLOBAL_ADMIN);
    expect(page.nextCursor).toBeNull();
    expect(page.changes).toEqual([
      expect.objectContaining({
        board: expect.objectContaining({ uuid: second.uuid, boardType: 'moonboard' }),
        gym: expect.objectContaining({ uuid: listedGym.uuid, name: 'Listed Wall' }),
        after: { layoutId: 3, sizeId: 1, setIds: '5,6', angle: 25 },
        climberDisplayName: CLIMBER_B,
        state: 'LIVE',
      }),
      expect.objectContaining({
        board: expect.objectContaining({ uuid: first.uuid }),
        before: { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 40 },
        climberDisplayName: CLIMBER_A,
        state: 'UNDONE',
      }),
    ]);

    const firstPage = await setupChanges(GLOBAL_ADMIN, { first: 1 });
    expect(firstPage.changes.map((change) => change.board.uuid)).toEqual([second.uuid]);
    const nextPage = await setupChanges(GLOBAL_ADMIN, { first: 1, after: firstPage.nextCursor });
    expect(nextPage.changes.map((change) => change.board.uuid)).toEqual([first.uuid]);
    expect(nextPage.nextCursor).toBeNull();

    await updateBoardRecord({ boardUuid: second.uuid, setIds: '5' }, authCtx(CREATOR));
    expect((await setupChanges(GLOBAL_ADMIN)).changes[0].state).toBe('CHANGED_SINCE');

    await expect(setupChanges(CREATOR)).rejects.toThrow(/Admin/);
  });
});
