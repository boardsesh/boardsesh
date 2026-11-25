import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_JOB_OPTIONS,
  SPRAY_DETECTION_MODEL_VERSION,
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_WEIGHTS_SHA256,
  type ConnectionContext,
} from '@boardsesh/shared-schema';
import {
  sprayWallDetections,
  sprayWallHolds,
  sprayWallVersions,
  sprayWalls,
  userBoards,
  users,
} from '@boardsesh/db/schema';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { db } from '../db/client';
import { requireJobQueue, startJobQueue, stopJobQueue } from '../services/job-queue';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import {
  describeFailure,
  parseArgs,
  reviveExpiredSprayDetections,
  type RevivalDecision,
} from '../scripts/revive-expired-spray-detections';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const context = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: userId }) as ConnectionContext;
const ignoreReport = () => undefined;
const DAY_MS = 86_400_000;

let windowsHandedOut = 0;
/** A day in 2001 that no other test's expired rows fall into, with a spare day either side. */
function testWindow() {
  const since = new Date(Date.UTC(2001, 0, 2 + 2 * windowsHandedOut++));
  return {
    since,
    until: new Date(since.getTime() + DAY_MS),
    at: (minute: number) => new Date(since.getTime() + minute * 60_000),
  };
}

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Revival test' });
  return userId;
}

/** A draft with a photo, owned by a new climber. */
async function draftWall() {
  const ownerId = await createUser();
  const created = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: 'Revival wall', angle: 40 } },
    context(ownerId),
  )) as { uuid: string };
  const [wall] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, created.uuid));
  const [version] = await db
    .insert(sprayWallVersions)
    .values({
      wallId: wall.id,
      versionNumber: 1,
      status: 'draft',
      photoKey: `spray-walls/${created.uuid}/test.jpg`,
      photoWidth: 800,
      photoHeight: 600,
    })
    .returning();
  return { ownerId, wall, version };
}

type Draft = Awaited<ReturnType<typeof draftWall>>;

/** A detection the backend's reconcile expired after 24 hours in the queue. */
async function expireDetection(draft: Draft, createdAt: Date, requestedBy: string = draft.ownerId) {
  const [expired] = await db
    .insert(sprayWallDetections)
    .values({
      id: randomUUID(),
      wallId: draft.wall.id,
      versionId: draft.version.id,
      requestedBy,
      photoKey: draft.version.photoKey!,
      photoWidth: draft.version.photoWidth!,
      photoHeight: draft.version.photoHeight!,
      jobId: randomUUID(),
      modelVersion: SPRAY_DETECTION_MODEL_VERSION,
      weightsSha256: SPRAY_DETECTION_WEIGHTS_SHA256,
      status: 'failed',
      error: 'QUEUE_EXPIRED',
      createdAt,
      finishedAt: new Date(createdAt.getTime() + DAY_MS),
    })
    .returning();
  return expired;
}

async function detectionsFor(draft: Draft) {
  return db
    .select()
    .from(sprayWallDetections)
    .where(eq(sprayWallDetections.versionId, draft.version.id))
    .orderBy(asc(sprayWallDetections.createdAt));
}

function decisionsById(decisions: RevivalDecision[]): Map<string, string> {
  return new Map(decisions.map((decision) => [decision.expiredId, decision.decision]));
}

describe('reviving spray imports a detector outage expired', () => {
  beforeAll(async () => {
    // Same bootstrap as spray-detection.test.ts: the migrator's owner connection
    // installs the pg-boss schema, then the backend queue starts on it.
    const ownerClient = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await initializeJobQueueSchema(drizzle(ownerClient));
    } finally {
      await ownerClient.end();
    }
    const boss = await startJobQueue();
    await boss.createQueue(SPRAY_DETECTION_DEAD_QUEUE, { partition: false });
    await boss.createQueue(SPRAY_DETECTION_QUEUE, { partition: false, ...SPRAY_DETECTION_JOB_OPTIONS });
  });
  afterAll(async () => {
    await stopJobQueue();
  });

  it('queues an eligible import again for its original requester', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const expired = await expireDetection(draft, expiryWindow.at(5));

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: requireJobQueue(),
      report: ignoreReport,
    });

    expect(decisions).toEqual([
      expect.objectContaining({ expiredId: expired.id, decision: 'revive', requestedBy: draft.ownerId }),
    ]);
    const [, revived] = await detectionsFor(draft);
    expect(revived).toMatchObject({
      id: decisions[0].revivedId,
      status: 'pending',
      requestedBy: draft.ownerId,
      wallId: draft.wall.id,
      photoKey: expired.photoKey,
      photoWidth: expired.photoWidth,
      photoHeight: expired.photoHeight,
    });
    const job = await requireJobQueue().getJobById(SPRAY_DETECTION_QUEUE, revived.jobId);
    expect(job?.data).toEqual({ detectionId: revived.id });
    // The expired row stays as it was: history, not something to rewrite.
    const [unchanged] = await db.select().from(sprayWallDetections).where(eq(sprayWallDetections.id, expired.id));
    expect(unchanged).toMatchObject({ status: 'failed', error: 'QUEUE_EXPIRED' });
  });

  it('leaves a draft alone once the climber placed a hold on it by hand', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const expired = await expireDetection(draft, expiryWindow.at(5));
    await db.insert(sprayWallHolds).values({
      wallId: draft.wall.id,
      holdId: 1,
      cx: 100,
      cy: 100,
      r: 10,
      installedVersionId: draft.version.id,
    });

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: requireJobQueue(),
      report: ignoreReport,
    });

    expect(decisions).toMatchObject([{ expiredId: expired.id, decision: 'skip:manual-edits', revivedId: null }]);
    expect(await detectionsFor(draft)).toHaveLength(1);
  });

  it('leaves a draft alone once the climber took a hold off by hand', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const expired = await expireDetection(draft, expiryWindow.at(5));
    const [earlier] = await db
      .insert(sprayWallVersions)
      .values({ wallId: draft.wall.id, versionNumber: 2, status: 'superseded' })
      .returning();
    await db.insert(sprayWallHolds).values({
      wallId: draft.wall.id,
      holdId: 1,
      cx: 100,
      cy: 100,
      r: 10,
      installedVersionId: earlier.id,
      removedVersionId: draft.version.id,
    });

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: requireJobQueue(),
      report: ignoreReport,
    });

    expect(decisions).toMatchObject([{ expiredId: expired.id, decision: 'skip:manual-edits', revivedId: null }]);
    expect(await detectionsFor(draft)).toHaveLength(1);
  });

  it('revives only the latest request when a retry superseded an earlier one', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const first = await expireDetection(draft, expiryWindow.at(5));
    const retry = await expireDetection(draft, expiryWindow.at(10));

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: requireJobQueue(),
      report: ignoreReport,
    });

    expect(decisionsById(decisions)).toEqual(
      new Map([
        [first.id, 'skip:superseded'],
        [retry.id, 'revive'],
      ]),
    );
    expect(await detectionsFor(draft)).toHaveLength(3);
  });

  it('skips walls that changed and requesters who lost edit access', async () => {
    const expiryWindow = testWindow();
    const published = await draftWall();
    const deleted = await draftWall();
    const archived = await draftWall();
    const boardDeleted = await draftWall();
    const rephotographed = await draftWall();
    const strangers = await draftWall();
    const stranger = await createUser();
    const expected = new Map([
      [(await expireDetection(published, expiryWindow.at(1))).id, 'skip:not-draft'],
      [(await expireDetection(deleted, expiryWindow.at(2))).id, 'skip:wall-deleted'],
      [(await expireDetection(archived, expiryWindow.at(3))).id, 'skip:wall-archived'],
      [(await expireDetection(boardDeleted, expiryWindow.at(4))).id, 'skip:board-deleted'],
      [(await expireDetection(rephotographed, expiryWindow.at(5))).id, 'skip:photo-changed'],
      [(await expireDetection(strangers, expiryWindow.at(6), stranger)).id, 'skip:no-edit-access'],
    ]);
    await db
      .update(sprayWallVersions)
      .set({ status: 'published' })
      .where(eq(sprayWallVersions.id, published.version.id));
    await db.update(sprayWalls).set({ deletedAt: new Date() }).where(eq(sprayWalls.id, deleted.wall.id));
    await db.update(sprayWalls).set({ archivedAt: new Date() }).where(eq(sprayWalls.id, archived.wall.id));
    await db.update(userBoards).set({ deletedAt: new Date() }).where(eq(userBoards.uuid, boardDeleted.wall.boardUuid));
    await db
      .update(sprayWallVersions)
      .set({ photoKey: `spray-walls/${rephotographed.wall.boardUuid}/second.jpg` })
      .where(eq(sprayWallVersions.id, rephotographed.version.id));

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: requireJobQueue(),
      report: ignoreReport,
    });

    expect(decisionsById(decisions)).toEqual(expected);
    for (const draft of [published, deleted, archived, boardDeleted, rephotographed, strangers]) {
      expect(await detectionsFor(draft)).toHaveLength(1);
    }
  });

  it('writes nothing on a dry run and reports truncated ids only', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const expired = await expireDetection(draft, expiryWindow.at(5));
    const lines: string[] = [];

    const decisions = await reviveExpiredSprayDetections({
      ...expiryWindow,
      boss: null,
      report: (line) => lines.push(line),
    });

    expect(decisions).toMatchObject([{ expiredId: expired.id, decision: 'revive', revivedId: null }]);
    expect(await detectionsFor(draft)).toHaveLength(1);
    expect(lines).toEqual([
      `detection=${expired.id.slice(0, 8)} wall=${draft.wall.boardUuid.slice(0, 8)} ` +
        `requester=${draft.ownerId.slice(0, 8)} created=${expiryWindow.at(5).toISOString()} revive`,
    ]);
    for (const fullValue of [expired.id, draft.wall.boardUuid, draft.ownerId, expired.photoKey]) {
      expect(lines[0]).not.toContain(fullValue);
    }
  });

  it('revives nothing on a second apply', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    const expired = await expireDetection(draft, expiryWindow.at(5));
    const run = () => reviveExpiredSprayDetections({ ...expiryWindow, boss: requireJobQueue(), report: ignoreReport });

    expect(await run()).toMatchObject([{ expiredId: expired.id, decision: 'revive' }]);
    expect(await run()).toMatchObject([{ expiredId: expired.id, decision: 'skip:superseded', revivedId: null }]);
    expect(await detectionsFor(draft)).toHaveLength(2);
  });

  it('only selects queue expiries inside the window', async () => {
    const expiryWindow = testWindow();
    const draft = await draftWall();
    await expireDetection(draft, new Date(expiryWindow.until.getTime()));
    await expireDetection(draft, new Date(expiryWindow.since.getTime() - 1));

    expect(await reviveExpiredSprayDetections({ ...expiryWindow, boss: null, report: ignoreReport })).toEqual([]);
  });
});

describe('revival failure output', () => {
  it('prints a failing query as its class and code, without parameters or ids', async () => {
    const detectionId = randomUUID();
    const requesterId = randomUUID();
    const photoKey = `spray-walls/${randomUUID()}/private.jpg`;
    // No wall -1 and no such requester: a foreign-key violation whose bound
    // parameters carry both ids and the photo key.
    const failure: unknown = await db
      .insert(sprayWallDetections)
      .values({
        id: detectionId,
        wallId: -1,
        versionId: -1,
        requestedBy: requesterId,
        photoKey,
        photoWidth: 800,
        photoHeight: 600,
        jobId: randomUUID(),
        modelVersion: SPRAY_DETECTION_MODEL_VERSION,
        weightsSha256: SPRAY_DETECTION_WEIGHTS_SHA256,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // The raw error is what used to be printed.
    expect(failure instanceof Error ? failure.message : '').toContain(requesterId);

    const output = describeFailure(failure);

    expect(output).toBe('DrizzleQueryError code=23503');
    expect(output).not.toContain('params');
    expect(output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(output).not.toContain(photoKey);
  });

  it('prints a bad command line in full', () => {
    let failure: unknown;
    try {
      parseArgs(['--since', 'yesterday']);
    } catch (error) {
      failure = error;
    }
    expect(describeFailure(failure)).toBe('--since must be an ISO timestamp with a zone, such as 2026-11-21T07:00:00Z');
  });
});

describe('revival arguments', () => {
  it('defaults to a dry run with an open-ended window', () => {
    expect(parseArgs(['--since', '2026-11-21T07:00:00Z'])).toEqual({
      since: new Date('2026-11-21T07:00:00Z'),
      until: null,
      apply: false,
    });
  });

  it('takes --until and --apply', () => {
    expect(parseArgs(['--since', '2026-11-21T07:00:00Z', '--until', '2026-11-25T00:00:00+10:00', '--apply'])).toEqual({
      since: new Date('2026-11-21T07:00:00Z'),
      until: new Date('2026-11-24T14:00:00Z'),
      apply: true,
    });
  });

  it.each([
    [[], '--since is required'],
    [['--since', '2026-11-21T07:00:00'], 'with a zone'],
    [['--since', 'yesterday'], 'with a zone'],
    [['--since', '2026-11-21T07:00:00Z', '--until', '2026-11-21T07:00:00Z'], '--until must be after --since'],
    [['--since', '2026-11-21T07:00:00Z', '--limit', '3'], 'Unknown option: --limit'],
    [['--since'], '--since requires an ISO timestamp'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
