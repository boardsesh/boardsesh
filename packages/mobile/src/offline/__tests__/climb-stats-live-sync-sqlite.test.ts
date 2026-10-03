import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import {
  runMigrations,
  writeClimbStatsEvents,
  type ClimbStatsWriteThroughInput,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

import { countClimbsLocal, searchClimbsLocal } from '../../db/queries/search-climbs-local';
import { getClimbLocal } from '../../db/queries/get-climb-local';
import { CLIMB_STATS_INVALIDATE_TRAILING_MS, createClimbStatsLiveSync } from '../climb-stats-live-sync';

type ScheduledTask = { callback: () => void; delayMs: number; cancelled: boolean };

const scheduledTasks: ScheduledTask[] = [];
let database: TestSqliteDb;
let queryClient: QueryClient;
let dispose: (() => void) | undefined;

function makeInput(overrides: Partial<ClimbSearchInput> = {}): ClimbSearchInput {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 5,
    setIds: '1',
    angle: 40,
    page: 0,
    pageSize: 1,
    sortBy: 'ascents',
    sortOrder: 'desc',
    ...overrides,
  } as ClimbSearchInput;
}

async function insertClimb(options: {
  uuid: string;
  boardType?: string;
  setAngle: number;
  sizeId?: number;
  setIds?: number[];
}): Promise<void> {
  const boardType = options.boardType ?? 'kilter';
  const sizeId = options.sizeId ?? 5;
  await database.runAsync(
    `INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, description, is_listed, is_draft, is_hidden,
       frames_count, frames, compatible_size_ids, required_set_ids, angle, created_at, updated_at)
     VALUES (?, ?, 1, ?, '', 1, 0, 0, 1, '', ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [
      options.uuid,
      boardType,
      `Climb ${options.uuid}`,
      JSON.stringify([sizeId]),
      JSON.stringify(options.setIds ?? [1]),
      options.setAngle,
    ],
  );
}

async function insertStats(options: {
  uuid: string;
  boardType?: string;
  angle: number;
  ascensions: number;
  syncSeq?: number;
}): Promise<void> {
  await database.runAsync(
    `INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
       ascensionist_count, difficulty_average, quality_average, updated_at, sync_seq)
     VALUES (?, ?, ?, 18, NULL, ?, 18, 3, '2026-01-01T00:00:00Z', ?)`,
    [options.boardType ?? 'kilter', options.uuid, options.angle, options.ascensions, options.syncSeq ?? 0],
  );
}

function makeEvent(options: {
  uuid: string;
  boardType?: string;
  angle: number;
  ascensions: number;
  syncSeq: string;
}): ClimbStatsWriteThroughInput {
  return {
    boardType: options.boardType ?? 'kilter',
    layoutId: 1,
    climbUuid: options.uuid,
    angle: options.angle,
    ascensionistCount: options.ascensions,
    qualityAverage: 3,
    difficultyAverage: 18,
    displayDifficulty: 18,
    syncSeq: options.syncSeq,
  };
}

function startSync(): {
  handle: (event: ClimbStatsWriteThroughInput) => void;
  drain: Promise<void>;
} {
  const writePromises: Promise<unknown>[] = [];
  const sync = createClimbStatsLiveSync({
    getDb: () => database as unknown as OfflineDatabase,
    queryClient,
    isScopeDownloaded: async () => true,
    shouldSkipWrites: () => false,
    hasEnabledScopeForBoard: () => true,
    writeEvents: (db, events) => {
      const writePromise = writeClimbStatsEvents(db, events);
      writePromises.push(writePromise);
      return writePromise;
    },
    scheduleTask: (callback, delayMs) => {
      const task: ScheduledTask = { callback, delayMs, cancelled: false };
      scheduledTasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  dispose = () => sync.dispose();
  return {
    handle: (event) => sync.handleEvent(event),
    get drain() {
      return new Promise<void>((resolve) => queueMicrotask(resolve))
        .then(() => Promise.all(writePromises))
        .then(() => undefined);
    },
  };
}

function runTrailingFlush(): void {
  const trailing = [...scheduledTasks]
    .reverse()
    .find((task) => !task.cancelled && task.delayMs === CLIMB_STATS_INVALIDATE_TRAILING_MS);
  if (!trailing) throw new Error('No active live-stats trailing flush was scheduled');
  trailing.cancelled = true;
  trailing.callback();
}

function isInvalidated(queryKey: unknown[]): boolean {
  return queryClient.getQueryCache().find({ queryKey, exact: true })?.state.isInvalidated ?? false;
}

async function waitForInvalidation(queryKey: unknown[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (isInvalidated(queryKey)) {
        resolve();
      } else if (Date.now() - startedAt > 1_000) {
        reject(new Error(`Query did not invalidate: ${JSON.stringify(queryKey)}`));
      } else {
        setTimeout(check, 0);
      }
    };
    check();
  });
}

async function cacheInfinitePages(input: ClimbSearchInput, pageNumbers: number[]): Promise<unknown[]> {
  const pages = await Promise.all(pageNumbers.map((page) => searchClimbsLocal(database, { ...input, page })));
  const key = ['infiniteSearchClimbs', input];
  queryClient.setQueryData(key, {
    pages: pages.map((page) => ({ searchClimbs: page })),
    pageParams: pageNumbers,
  });
  return key;
}

beforeEach(async () => {
  database = createTestDatabase();
  await runMigrations(database);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scheduledTasks.length = 0;
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  queryClient.clear();
  database.close();
});

describe('live-stat invalidation against SQLite pages', () => {
  it.each([
    ['ascents', 40],
    ['popular', 25],
  ] as const)(
    'refreshes page zero and page one when unseen %s-ranked climb enters the top page',
    async (sortBy, eventAngle) => {
      await insertClimb({ uuid: 'climb-a', setAngle: 40 });
      await insertClimb({ uuid: 'climb-b', setAngle: 40 });
      await insertStats({ uuid: 'climb-a', angle: 40, ascensions: 10 });
      await insertStats({ uuid: 'climb-b', angle: eventAngle, ascensions: 1 });

      const input = makeInput({ sortBy });
      const queryKey = await cacheInfinitePages(input, [0, 1]);
      const cachedPages = queryClient.getQueryData<{ pages: { searchClimbs: { climbs: { uuid: string }[] } }[] }>(
        queryKey,
      );
      expect(cachedPages?.pages.map((page) => page.searchClimbs.climbs[0]?.uuid)).toEqual(['climb-a', 'climb-b']);

      const sync = startSync();
      sync.handle(makeEvent({ uuid: 'climb-b', angle: eventAngle, ascensions: 100, syncSeq: '1' }));
      await sync.drain;
      runTrailingFlush();
      await waitForInvalidation(queryKey);

      const refreshedPage0 = await searchClimbsLocal(database, { ...input, page: 0 });
      const refreshedPage1 = await searchClimbsLocal(database, { ...input, page: 1 });
      expect(refreshedPage0.climbs.map((climb) => climb.uuid)).toEqual(['climb-b']);
      expect(refreshedPage1.climbs.map((climb) => climb.uuid)).toEqual(['climb-a']);
    },
  );

  it('invalidates Kilter and Woods set-angle filters, counts, and Woods detail', async () => {
    await insertClimb({ uuid: 'kilter-set-25', setAngle: 25 });
    await insertStats({ uuid: 'kilter-set-25', angle: 25, ascensions: 1 });
    await insertClimb({ uuid: 'woods-set-25', boardType: 'woods', setAngle: 25, sizeId: 1 });
    await insertStats({ uuid: 'woods-set-25', boardType: 'woods', angle: 25, ascensions: 1 });

    const kilterInput = makeInput({ crossAngleStats: true, minAscents: 10 });
    const woodsInput = makeInput({
      boardName: 'woods',
      sizeId: 1,
      angle: 40,
      name: 'Climb woods-set-25',
      minAscents: 10,
    });
    expect((await searchClimbsLocal(database, kilterInput)).climbs).toHaveLength(0);
    expect(await countClimbsLocal(database, kilterInput)).toBe(0);
    expect((await searchClimbsLocal(database, woodsInput)).climbs).toHaveLength(0);
    expect(await countClimbsLocal(database, woodsInput)).toBe(0);

    const kilterListKey = await cacheInfinitePages(kilterInput, [0]);
    const kilterCountKey = ['searchClimbsCount', kilterInput];
    queryClient.setQueryData(kilterCountKey, { searchClimbs: { totalCount: 0 } });
    const woodsListKey = await cacheInfinitePages(woodsInput, [0]);
    const woodsCountKey = ['searchClimbsCount', woodsInput];
    queryClient.setQueryData(woodsCountKey, { searchClimbs: { totalCount: 0 } });
    const detailVariables = { boardName: 'woods', layoutId: 1, sizeId: 1, angle: 40, climbUuid: 'woods-set-25' };
    const detailKey = ['climb', detailVariables];
    const beforeDetail = await getClimbLocal(database, detailVariables);
    expect(beforeDetail?.ascensionist_count).toBe(1);
    queryClient.setQueryData(detailKey, { climb: beforeDetail });

    const sync = startSync();
    sync.handle(makeEvent({ uuid: 'kilter-set-25', angle: 25, ascensions: 12, syncSeq: '1' }));
    await sync.drain;
    sync.handle(makeEvent({ uuid: 'woods-set-25', boardType: 'woods', angle: 25, ascensions: 12, syncSeq: '1' }));
    await sync.drain;
    runTrailingFlush();

    await Promise.all([kilterListKey, woodsListKey].map(waitForInvalidation));
    await Promise.all([kilterCountKey, woodsCountKey, detailKey].map(waitForInvalidation));
    expect((await searchClimbsLocal(database, kilterInput)).climbs.map((climb) => climb.uuid)).toEqual([
      'kilter-set-25',
    ]);
    expect(await countClimbsLocal(database, kilterInput)).toBe(1);
    expect((await searchClimbsLocal(database, woodsInput)).climbs.map((climb) => climb.uuid)).toEqual(['woods-set-25']);
    expect(await countClimbsLocal(database, woodsInput)).toBe(1);
    const afterDetail = await getClimbLocal(database, detailVariables);
    expect(afterDetail?.ascensionist_count).toBe(12);
  });
});
