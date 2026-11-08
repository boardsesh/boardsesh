import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';

type CapturedOptions = {
  properties: Record<string, string | number>;
  systemDistinctId: string;
  timestamp: Date;
  uuid: string;
};
const { captureMock, flushMock } = vi.hoisted(() => ({
  captureMock: vi.fn((_event: string, _options: CapturedOptions) => true),
  flushMock: vi.fn(async () => {}),
}));
vi.mock('../analytics/posthog', () => ({ captureBackendEvent: captureMock, flushBackendEvents: flushMock }));

import { db } from '../../db/client';
import {
  computeHistoricalActiveUsersSnapshots,
  HistoricalActivityCoverageError,
  historicalSnapshotDays,
  publishHistoricalActiveUsersSnapshots,
} from '../historical-active-users';

async function createUser(createdAt = '2020-01-01T00:00:00.000Z'): Promise<string> {
  const id = randomUUID();
  await db.insert(dbSchema.users).values({ id, email: `${id}@example.invalid`, createdAt: new Date(createdAt) });
  return id;
}

async function tick(
  userId: string,
  createdAt: string,
  {
    climbedAt = createdAt,
    origin = 'native',
    auroraId,
  }: {
    climbedAt?: string;
    origin?: typeof dbSchema.boardseshTicks.$inferInsert.origin;
    auroraId?: string;
  } = {},
): Promise<void> {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: randomUUID(),
    userId,
    boardType: 'kilter',
    climbUuid: randomUUID(),
    angle: 40,
    status: 'send',
    createdAt,
    climbedAt,
    origin,
    auroraId,
  });
}

async function session(
  creator: string,
  createdAt: string,
  origin: 'explicit' | 'inferred' = 'explicit',
): Promise<string> {
  const id = randomUUID();
  await db.insert(dbSchema.boardSessions).values({
    id,
    boardPath: origin === 'explicit' ? 'kilter/1/1/1/40' : null,
    createdByUserId: creator,
    createdAt: new Date(createdAt),
    origin,
  });
  return id;
}

beforeEach(async () => {
  await db.delete(dbSchema.users);
  captureMock.mockClear();
  flushMock.mockClear();
});

describe('historical month-end active-account proxy', () => {
  it('deduplicates accounts across days, ticks, session creation and participation inside each window', async () => {
    const sameAccount = await createUser();
    const participant = await createUser();
    await tick(sameAccount, '2021-02-01T10:00:00Z');
    await tick(sameAccount, '2021-02-15T10:00:00Z');
    const sessionId = await session(sameAccount, '2021-02-20T10:00:00Z');
    await db.insert(dbSchema.boardSessionParticipants).values([
      { sessionId, userId: sameAccount, joinedAt: new Date('2021-02-20T10:01:00Z') },
      { sessionId, userId: participant, joinedAt: new Date('2021-02-20T10:02:00Z') },
    ]);
    const snapshots = await computeHistoricalActiveUsersSnapshots({
      database: db,
      now: new Date('2021-03-01T00:00:00Z'),
    });
    expect(snapshots).toEqual([
      expect.objectContaining({
        snapshotDay: '2021-02-28',
        windowStart: '2021-01-30',
        windowEnd: '2021-02-28',
        activeUsers30d: 2,
        basis: 'historical_action_proxy',
      }),
    ]);
    expect(JSON.stringify(snapshots)).not.toContain(sameAccount);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('uses tick creation time, includes uploaded native ticks, and excludes imports and inferred sessions', async () => {
    const native = await createUser();
    const imported = await createUser();
    const inferred = await createUser();
    const inferredParticipant = await createUser();
    await tick(native, '2021-02-15T10:00:00Z', { climbedAt: '2020-01-01T10:00:00Z', auroraId: randomUUID() });
    await tick(imported, '2021-02-15T10:00:00Z', { origin: 'aurora_pull' });
    await tick(imported, '2021-03-02T10:00:00Z', { climbedAt: '2021-02-15T10:00:00Z' });
    const sessionId = await session(inferred, '2021-02-15T10:00:00Z', 'inferred');
    await db.insert(dbSchema.boardSessionParticipants).values({
      sessionId,
      userId: inferredParticipant,
      joinedAt: new Date('2021-02-15T10:01:00Z'),
    });
    const snapshots = await computeHistoricalActiveUsersSnapshots({
      database: db,
      now: new Date('2021-03-01T00:00:00Z'),
    });
    expect(snapshots.map(({ snapshotDay, activeUsers30d }) => ({ snapshotDay, activeUsers30d }))).toEqual([
      { snapshotDay: '2021-02-28', activeUsers30d: 1 },
    ]);
  });

  it('excludes actions before account creation and keeps exact rolling-window edges', async () => {
    const beforeStart = await createUser();
    const atStart = await createUser();
    const atEnd = await createUser();
    const afterEnd = await createUser();
    const notYetCreated = await createUser('2021-03-01T00:00:00Z');
    await tick(beforeStart, '2021-01-29T23:59:59Z');
    await tick(atStart, '2021-01-30T00:00:00Z');
    await tick(atEnd, '2021-02-28T23:59:59Z');
    await tick(afterEnd, '2021-03-01T00:00:00Z');
    await tick(notYetCreated, '2021-02-15T10:00:00Z');
    await session(notYetCreated, '2021-02-15T10:00:00Z');
    const sessionId = await session(atStart, '2021-02-15T10:00:00Z');
    await db.insert(dbSchema.boardSessionParticipants).values({
      sessionId,
      userId: notYetCreated,
      joinedAt: new Date('2021-02-15T10:01:00Z'),
    });
    const snapshots = await computeHistoricalActiveUsersSnapshots({
      database: db,
      now: new Date('2021-03-01T00:00:00Z'),
    });
    expect(snapshots.find((snapshot) => snapshot.snapshotDay === '2021-02-28')?.activeUsers30d).toBe(2);
  });

  it('switches sources at October 9 and deduplicates the mixed bridge across platforms', async () => {
    const bothSources = await createUser();
    const requestOnly = await createUser();
    const ignoredPostCutover = await createUser();
    await tick(bothSources, '2026-10-08T23:59:59Z');
    await tick(ignoredPostCutover, '2026-10-09T00:00:00Z');
    await session(ignoredPostCutover, '2026-10-10T10:00:00Z');
    await db.insert(dbSchema.userActivityDays).values([
      { userId: ignoredPostCutover, day: '2026-10-08', platform: 'ios' },
      { userId: bothSources, day: '2026-10-09', platform: 'ios' },
      { userId: bothSources, day: '2026-10-10', platform: 'android' },
      { userId: requestOnly, day: '2026-10-31', platform: 'web' },
      { userId: ignoredPostCutover, day: '2026-11-01', platform: 'web' },
    ]);
    const snapshots = await computeHistoricalActiveUsersSnapshots({
      database: db,
      now: new Date('2026-11-08T00:00:00Z'),
    });
    expect(snapshots.at(-1)).toMatchObject({
      snapshotDay: '2026-10-31',
      windowStart: '2026-10-02',
      activeUsers30d: 2,
      basis: 'mixed_action_proxy_and_requests',
    });
    expect(snapshots.every((snapshot) => snapshot.snapshotDay < '2026-11-07')).toBe(true);
  });

  it.each([
    ['2026-10-10', '2026-10-31'],
    ['2026-10-09', '2026-10-30'],
  ])('refuses mixed-window recomputation with retained request days %s through %s', async (firstDay, lastDay) => {
    const account = await createUser();
    await tick(account, '2026-09-01T10:00:00Z');
    await db.insert(dbSchema.userActivityDays).values([
      { userId: account, day: firstDay, platform: 'ios' },
      { userId: account, day: lastDay, platform: 'web' },
    ]);
    await expect(
      computeHistoricalActiveUsersSnapshots({ database: db, now: new Date('2026-11-08T00:00:00Z') }),
    ).rejects.toBeInstanceOf(HistoricalActivityCoverageError);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('dates and keys a separate aggregate event, with stable rerun UUIDs and no account identities', async () => {
    const account = await createUser();
    await tick(account, '2021-02-15T10:00:00Z');
    const snapshots = await computeHistoricalActiveUsersSnapshots({
      database: db,
      now: new Date('2021-03-01T00:00:00Z'),
    });
    await publishHistoricalActiveUsersSnapshots(snapshots);
    await publishHistoricalActiveUsersSnapshots(snapshots);
    expect(captureMock.mock.calls[0]).toEqual([
      'Historical Active Users Snapshot',
      expect.objectContaining({
        systemDistinctId: 'system:historical-active-users',
        timestamp: new Date('2021-02-28T12:00:00Z'),
        properties: expect.objectContaining({ snapshotDay: '2021-02-28', activeUsers30d: 1, version: 'v1' }),
      }),
    ]);
    expect(captureMock.mock.calls[0][1].uuid).toBe(captureMock.mock.calls[1][1].uuid);
    expect(JSON.stringify(captureMock.mock.calls)).not.toContain(account);
    expect(flushMock).toHaveBeenCalledTimes(2);
  });

  it('starts with the first local-action month and emits no incomplete or request-only month', () => {
    expect(historicalSnapshotDays('2026-09-15', new Date('2026-11-08T00:00:00Z'))).toEqual([
      '2026-09-30',
      '2026-10-31',
    ]);
    expect(historicalSnapshotDays('2021-02-15', new Date('2021-02-28T23:59:59Z'))).toEqual([]);
  });
});
