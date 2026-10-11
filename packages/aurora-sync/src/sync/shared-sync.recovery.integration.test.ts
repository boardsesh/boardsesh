import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { drizzle as drizzleFactory } from 'drizzle-orm/postgres-js';
import type { Climb, SyncData } from '../api/sync-api-types';

const { mockSharedSync, mockPopulateDenormalizedColumns, mockSnapshotHistory } = vi.hoisted(() => ({
  mockSharedSync: vi.fn(),
  mockPopulateDenormalizedColumns: vi.fn().mockResolvedValue(undefined),
  mockSnapshotHistory: vi.fn().mockResolvedValue({ written: 0, skipped: true }),
}));

vi.mock('../api/shared-sync-api', () => ({ sharedSync: mockSharedSync }));
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    populateDenormalizedColumns: mockPopulateDenormalizedColumns,
    snapshotClimbStatsHistoryIfDue: mockSnapshotHistory,
  };
});

const EXPECTED_DATABASE_NAME = 'boardsesh_pr_sweep_4161';
const EXPECTED_DATABASE_USER = 'boardsesh_4161';
const EXPECTED_DATABASE_PASSWORD = 'fixture-only-4161';
const EXPECTED_REDIS_URL = 'redis://127.0.0.1:9/0';

type PostgresFactory = typeof import('postgres');
type PostgresClient = ReturnType<PostgresFactory>;
type DrizzleFactory = typeof drizzleFactory;
type DrizzleDatabase = ReturnType<DrizzleFactory>;
type SharedSync = typeof import('./shared-sync').syncSharedData;
type SyncOptions = Parameters<SharedSync>[4];
type StoredClimb = {
  uuid: string;
  board_type: string;
  frames: string | null;
  frames_count: number | null;
  frames_pace: number | null;
  user_id: string | null;
};
type StoredHold = { hold_id: number; frame_number: number; hold_state: string };

/** Validate the synthetic-only target before importing any database module. */
function approvedOwnedTarget(): { databaseUrl: string; port: number } | null {
  if (process.env.BOARDSESH_4161_SQL_APPROVED !== '1') return null;

  const databaseUrl = process.env.DATABASE_URL;
  const postgresUrl = process.env.POSTGRES_URL;
  const expectedPort = Number(process.env.BOARDSESH_4161_OWNED_PG_PORT);
  const inspectedContainerId = process.env.BOARDSESH_4161_OWNED_CONTAINER_ID;
  if (!databaseUrl || !postgresUrl || databaseUrl !== postgresUrl) {
    throw new Error('4161 integration requires matching, explicitly owned DATABASE_URL and POSTGRES_URL');
  }
  if (!Number.isInteger(expectedPort) || expectedPort < 1024 || expectedPort > 65535) {
    throw new Error('4161 integration requires the inspected task-owned PostgreSQL host port');
  }
  if (!inspectedContainerId || !/^[0-9a-f]{64}$/i.test(inspectedContainerId)) {
    throw new Error('4161 integration requires the inspected task-owned container ID');
  }
  if (process.env.REDIS_URL !== EXPECTED_REDIS_URL) {
    throw new Error(`4161 integration requires dead Redis guard ${EXPECTED_REDIS_URL}`);
  }
  if ((process.env.READ_REPLICA_URL ?? '') !== '') {
    throw new Error('4161 integration requires a blank READ_REPLICA_URL');
  }

  const parsedUrl = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    parsedUrl.hostname !== '127.0.0.1' ||
    parsedUrl.port !== String(expectedPort) ||
    parsedUrl.pathname !== `/${EXPECTED_DATABASE_NAME}` ||
    decodeURIComponent(parsedUrl.username) !== EXPECTED_DATABASE_USER ||
    decodeURIComponent(parsedUrl.password) !== EXPECTED_DATABASE_PASSWORD
  ) {
    throw new Error(
      '4161 integration target must be the inspected loopback port and unique synthetic fixture database',
    );
  }

  return { databaseUrl, port: expectedPort };
}

const target = approvedOwnedTarget();
const describeOwned = target ? describe : describe.skip;

describeOwned('Aurora shared-sync missing-frame recovery in owned PostgreSQL', () => {
  let postgres: PostgresFactory | undefined;
  let drizzle: DrizzleFactory | undefined;
  let client: PostgresClient | undefined;
  let database: DrizzleDatabase | undefined;
  let syncSharedData: SharedSync | undefined;

  function databaseOrThrow(): DrizzleDatabase {
    if (!database) throw new Error('4161 owned database has not been initialized');
    return database;
  }

  function clientOrThrow(): PostgresClient {
    if (!client) throw new Error('4161 owned database connection has not been initialized');
    return client;
  }

  function postgresOrThrow(): PostgresFactory {
    if (!postgres) throw new Error('4161 PostgreSQL driver has not been initialized');
    return postgres;
  }

  function syncSharedDataOrThrow(): SharedSync {
    if (!syncSharedData) throw new Error('4161 shared-sync module has not been initialized');
    return syncSharedData;
  }

  function drizzleOrThrow(): DrizzleFactory {
    if (!drizzle) throw new Error('4161 Drizzle factory has not been initialized');
    return drizzle;
  }

  beforeAll(async () => {
    if (!target) throw new Error('the dedicated 4161 SQL approval flag was not supplied');

    const [{ default: postgresModule }, drizzleModule, sharedSyncModule, fixtureModule] = await Promise.all([
      import('postgres'),
      import('drizzle-orm/postgres-js'),
      import('./shared-sync'),
      import('./shared-sync.recovery.integration-fixture'),
    ]);
    postgres = postgresModule;
    drizzle = drizzleModule.drizzle;
    const ownedClient = postgresModule(target.databaseUrl, {
      max: 2,
      prepare: false,
      idle_timeout: 5,
      onnotice: () => {},
    });
    client = ownedClient;

    // This must remain the first SQL statement after connecting: identify the
    // isolated synthetic database before creating any fixture tables.
    const [identity] = await ownedClient<{ current_database: string }[]>`SELECT current_database()`;
    if (identity?.current_database !== EXPECTED_DATABASE_NAME) {
      throw new Error(`4161 fixture identity mismatch: expected ${EXPECTED_DATABASE_NAME}`);
    }

    database = drizzleModule.drizzle(ownedClient);
    syncSharedData = sharedSyncModule.syncSharedData;
    await fixtureModule.initializeAuroraRecoveryFixture(ownedClient);
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  beforeEach(() => {
    mockSharedSync.mockReset();
    mockPopulateDenormalizedColumns.mockReset();
    mockPopulateDenormalizedColumns.mockResolvedValue(undefined);
    mockSnapshotHistory.mockReset();
    mockSnapshotHistory.mockResolvedValue({ written: 0, skipped: true });
  });

  function climb(uuid: string, frames: string, overrides: Partial<Climb> = {}): Climb {
    return {
      uuid,
      name: '4161 fixture climb',
      description: '',
      hsm: 1,
      edge_left: 0,
      edge_right: 0,
      edge_bottom: 0,
      edge_top: 0,
      frames_count: 1,
      frames_pace: 9,
      frames,
      setter_id: 0,
      setter_username: '',
      layout_id: 1,
      is_draft: true,
      is_listed: false,
      created_at: '2026-10-04 00:00:00',
      updated_at: '2026-10-04 00:00:00',
      angle: 40,
      ...overrides,
    };
  }

  function responseFor(climbRows: Climb[]): SyncData {
    return { _complete: true, climbs: climbRows };
  }

  async function runSync(
    climbRows: Climb[],
    token = randomUUID(),
    db = databaseOrThrow(),
    options?: SyncOptions,
    board: 'decoy' | 'kilter' = 'decoy',
  ): Promise<void> {
    mockSharedSync.mockResolvedValueOnce(responseFor(climbRows));
    await syncSharedDataOrThrow()(db, board, token, () => {}, options);
  }

  async function seedClimb(
    uuid: string,
    overrides: Partial<{
      boardType: string;
      frames: string | null;
      framesCount: number | null;
      framesPace: number | null;
      userId: string | null;
      name: string;
    }> = {},
  ): Promise<void> {
    const dbClient = clientOrThrow();
    await dbClient`
      INSERT INTO board_climbs (
        uuid, board_type, layout_id, setter_id, setter_username, name, description,
        frames, frames_count, frames_pace, is_draft, is_listed, user_id, created_at
      ) VALUES (
        ${uuid}, ${overrides.boardType ?? 'decoy'}, 1, 0, '', ${overrides.name ?? '4161 fixture climb'}, '',
        ${overrides.frames ?? null}, ${overrides.framesCount ?? 1}, ${overrides.framesPace ?? 9},
        true, false, ${overrides.userId ?? null}, '2026-10-04 00:00:00'
      )
    `;
  }

  async function readClimb(uuid: string): Promise<StoredClimb> {
    const dbClient = clientOrThrow();
    const [stored] = await dbClient<StoredClimb[]>`
      SELECT uuid, board_type, frames, frames_count, frames_pace, user_id
      FROM board_climbs WHERE uuid = ${uuid}
    `;
    if (!stored) throw new Error(`fixture climb ${uuid} was not written`);
    return stored;
  }

  async function readHolds(uuid: string): Promise<StoredHold[]> {
    const dbClient = clientOrThrow();
    return dbClient<StoredHold[]>`
      SELECT hold_id, frame_number, hold_state
      FROM board_climb_holds
      WHERE climb_uuid = ${uuid}
      ORDER BY frame_number, hold_id
    `;
  }

  function expectedHold(holdId: number, holdState: string): StoredHold {
    return { hold_id: holdId, frame_number: 0, hold_state: holdState };
  }

  it('recovers NULL and empty sources with holds and repeated syncs stay idempotent', async () => {
    for (const missingFrames of [null, ''] as const) {
      const uuid = randomUUID();
      const incomingFrames = 'p101r1p202r2';
      await seedClimb(uuid, { frames: missingFrames });

      await runSync([climb(uuid, incomingFrames, { frames_pace: 12 })]);
      await runSync([climb(uuid, incomingFrames, { frames_pace: 12 })]);

      const stored = await readClimb(uuid);
      expect(stored).toMatchObject({ frames: incomingFrames, frames_count: 1, frames_pace: 12 });
      expect(await readHolds(uuid)).toEqual([expectedHold(101, 'STARTING'), expectedHold(202, 'HAND')]);
    }
  });

  it.each([null, ''])('recovers the delayed-start Kilter source from a missing %s source', async (missingFrames) => {
    const uuid = randomUUID();
    const incomingFrames = ',"p100r13';
    await seedClimb(uuid, { boardType: 'kilter', frames: missingFrames });

    await runSync(
      [climb(uuid, incomingFrames, { frames_count: 2, frames_pace: 2 })],
      randomUUID(),
      databaseOrThrow(),
      undefined,
      'kilter',
    );
    await runSync(
      [climb(uuid, incomingFrames, { frames_count: 2, frames_pace: 2 })],
      randomUUID(),
      databaseOrThrow(),
      undefined,
      'kilter',
    );

    expect(await readClimb(uuid)).toMatchObject({
      board_type: 'kilter',
      frames: incomingFrames,
      frames_count: 2,
      frames_pace: 2,
    });
    expect(await readHolds(uuid)).toEqual([{ hold_id: 100, frame_number: 0, hold_state: 'HAND' }]);
  });

  it('preserves an existing nonempty same-board source and projects only its holds', async () => {
    const uuid = randomUUID();
    await seedClimb(uuid, { frames: 'p303r1', framesPace: 7 });

    await runSync([climb(uuid, 'p404r2', { frames_pace: 14 })]);

    expect(await readClimb(uuid)).toMatchObject({ frames: 'p303r1', frames_pace: 7 });
    expect(await readHolds(uuid)).toEqual([expectedHold(303, 'STARTING')]);
  });

  it('leaves cross-board and user-owned UUID collisions untouched', async () => {
    const crossBoardUuid = randomUUID();
    const userOwnedUuid = randomUUID();
    await seedClimb(crossBoardUuid, { boardType: 'tension', frames: 'p505r1' });
    await seedClimb(userOwnedUuid, { frames: 'p606r1', userId: 'synthetic-user-4161' });

    await runSync([climb(crossBoardUuid, 'p507r2'), climb(userOwnedUuid, 'p608r2')]);

    expect(await readClimb(crossBoardUuid)).toMatchObject({ board_type: 'tension', frames: 'p505r1', user_id: null });
    expect(await readClimb(userOwnedUuid)).toMatchObject({
      board_type: 'decoy',
      frames: 'p606r1',
      user_id: 'synthetic-user-4161',
    });
    expect(await readHolds(crossBoardUuid)).toEqual([]);
    expect(await readHolds(userOwnedUuid)).toEqual([]);
  });

  it('does not heal absent sources from malformed or empty incoming frames', async () => {
    const emptyUuid = randomUUID();
    const malformedUuid = randomUUID();
    const unknownRoleUuid = randomUUID();
    await seedClimb(emptyUuid, { frames: null });
    await seedClimb(malformedUuid, { frames: null });
    await seedClimb(unknownRoleUuid, { frames: null });

    await runSync([
      climb(emptyUuid, '', { frames_count: 0 }),
      climb(malformedUuid, 'not-an-aurora-frame'),
      climb(unknownRoleUuid, 'p901r1p902r999'),
    ]);

    expect(await readClimb(emptyUuid)).toMatchObject({ frames: null, frames_count: 1, frames_pace: 9 });
    expect(await readClimb(malformedUuid)).toMatchObject({ frames: null, frames_count: 1, frames_pace: 9 });
    expect(await readClimb(unknownRoleUuid)).toMatchObject({ frames: null, frames_count: 1, frames_pace: 9 });
    expect(await readHolds(emptyUuid)).toEqual([]);
    expect(await readHolds(malformedUuid)).toEqual([]);
    expect(await readHolds(unknownRoleUuid)).toEqual([]);
  });

  it('rolls back recovered frames and materialized holds together', async () => {
    const uuid = randomUUID();
    await seedClimb(uuid, { frames: null });
    const failAfterPageWrite: NonNullable<SyncOptions>['transaction'] = async (callback) =>
      databaseOrThrow().transaction(async (transaction) => {
        await callback(transaction);
        throw new Error('4161 intentional rollback after page writes');
      });

    await expect(
      runSync([climb(uuid, 'p707r1')], randomUUID(), databaseOrThrow(), {
        transaction: failAfterPageWrite,
      }),
    ).rejects.toThrow('4161 intentional rollback after page writes');

    expect(await readClimb(uuid)).toMatchObject({ frames: null, frames_count: 1, frames_pace: 9 });
    expect(await readHolds(uuid)).toEqual([]);
  });

  it('uses the source accepted under a concurrent row lock for hold projection', async () => {
    const uuid = randomUUID();
    await seedClimb(uuid, { frames: null });

    const appName = `boardsesh-4161-writer-${randomUUID().slice(0, 8)}`;
    const postgresFactory = postgresOrThrow();
    const lockClient = postgresFactory(target!.databaseUrl, {
      max: 1,
      prepare: false,
      idle_timeout: 5,
      onnotice: () => {},
    });
    const writerClient = postgresFactory(target!.databaseUrl, {
      max: 1,
      prepare: false,
      idle_timeout: 5,
      onnotice: () => {},
      connection: { application_name: appName },
    });
    let announceLockedRow!: () => void;
    const lockedRowReady = new Promise<void>((resolve) => {
      announceLockedRow = resolve;
    });
    let releaseLock!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockTransaction = lockClient.begin(async (transaction) => {
      await transaction`
        UPDATE board_climbs
        SET frames = 'p808r1', frames_count = 1, frames_pace = 11
        WHERE uuid = ${uuid}
      `;
      announceLockedRow();
      await waitForRelease;
    });

    let concurrentSync: Promise<void> | undefined;
    try {
      await lockedRowReady;
      const writerDatabase = drizzleOrThrow()(writerClient);
      concurrentSync = runSync([climb(uuid, 'p909r2', { frames_pace: 17 })], randomUUID(), writerDatabase);
      let writerSettled = false;
      void concurrentSync.then(
        () => {
          writerSettled = true;
        },
        () => {
          writerSettled = true;
        },
      );
      const deadline = Date.now() + 15_000;
      let blockedOnLock = false;
      while (Date.now() < deadline) {
        if (writerSettled) break;
        const observer = clientOrThrow();
        const activity = await observer<{ wait_event_type: string | null }[]>`
          SELECT wait_event_type
          FROM pg_stat_activity
          WHERE application_name = ${appName} AND state = 'active'
        `;
        if (activity.some((backendActivity) => backendActivity.wait_event_type === 'Lock')) {
          blockedOnLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blockedOnLock).toBe(true);
      releaseLock();
      await lockTransaction;
      await concurrentSync;

      expect(await readClimb(uuid)).toMatchObject({ frames: 'p808r1', frames_pace: 11 });
      expect(await readHolds(uuid)).toEqual([expectedHold(808, 'STARTING')]);
    } finally {
      releaseLock();
      await lockTransaction.catch(() => {});
      await concurrentSync?.catch(() => {});
      await lockClient.end({ timeout: 5 });
      await writerClient.end({ timeout: 5 });
    }
  }, 30_000);
});
