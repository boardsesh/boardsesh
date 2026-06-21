import { describe, expect, it } from 'vitest';
import { gyms, locationSyncGymSources, userBoards, users } from '@boardsesh/db/schema';
import type { CanonicalGymCandidate } from '@boardsesh/db/queries';
import type { PublicBoardLocationInput } from './types';
import {
  buildBoardWriteIdentifiers,
  buildGymWriteIdentifiers,
  buildLocationUpsertPlan,
  collectValidLocationRecords,
  collectUniqueGymLocationRecords,
  upsertPublicBoardLocations,
} from './upsert';

type UpsertDb = Parameters<typeof upsertPublicBoardLocations>[0];

const baseLocationRecord: PublicBoardLocationInput = {
  boardType: 'tension',
  layoutId: 10,
  sizeId: 6,
  setIds: '12,13',
  angle: 40,
  isAngleAdjustable: true,
  sourceKey: 'tension:board-1',
  gymSourceKey: 'tension:gym-1',
  name: 'Board One - Tension Board',
  slugBase: 'Board One-tension',
  locationName: null,
  latitude: -33.86,
  longitude: 151.2,
  gymName: 'Board House',
  gymAddress: null,
};

function locationRecord(overrides: Partial<PublicBoardLocationInput>): PublicBoardLocationInput {
  return { ...baseLocationRecord, ...overrides };
}

function sqlToText(fragment: unknown): string {
  if (typeof fragment === 'string') {
    return fragment;
  }

  if (!fragment || typeof fragment !== 'object') {
    return '';
  }

  const queryChunks = (fragment as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(queryChunks)) {
    return '';
  }

  return queryChunks
    .map((chunk) => {
      if (typeof chunk === 'string') {
        return chunk;
      }
      if (!chunk || typeof chunk !== 'object') {
        return '?';
      }

      const chunkValue = (chunk as { value?: unknown }).value;
      if (Array.isArray(chunkValue)) {
        return chunkValue.join('');
      }

      if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
        return sqlToText(chunk);
      }

      return '?';
    })
    .join('');
}

function tableLabel(table: unknown): string {
  if (Object.is(table, users)) return 'users';
  if (Object.is(table, gyms)) return 'gyms';
  if (Object.is(table, locationSyncGymSources)) return 'locationSyncGymSources';
  if (Object.is(table, userBoards)) return 'userBoards';
  return 'unknown';
}

function rowValues(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('expected row values object');
  }
  return row as Record<string, unknown>;
}

function candidate(overrides: Partial<CanonicalGymCandidate>): CanonicalGymCandidate {
  return {
    id: 500,
    uuid: 'physical-gym',
    name: 'Board House',
    address: null,
    contactEmail: null,
    contactPhone: null,
    description: null,
    imageUrl: null,
    latitude: -33.86,
    longitude: 151.2,
    createdAt: '2026-01-01T00:00:00Z',
    boardCount: 0,
    memberCount: 0,
    followerCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

class FakeInsertBuilder {
  private pendingRowValues: Record<string, unknown> | null = null;

  constructor(
    private readonly fakeDb: FakeLocationSyncDb,
    private readonly table: unknown,
  ) {}

  values(nextRowValues: unknown): this {
    this.pendingRowValues = rowValues(nextRowValues);
    return this;
  }

  onConflictDoNothing(_config: unknown): Promise<void> {
    if (Object.is(this.table, users) && this.pendingRowValues) {
      this.fakeDb.systemUserWrites.push(this.pendingRowValues);
    }
    return Promise.resolve();
  }

  onConflictDoUpdate(_config: unknown): this {
    if (Object.is(this.table, locationSyncGymSources) && this.pendingRowValues) {
      this.fakeDb.sourceAliasWrites.push(this.pendingRowValues);
    }
    return this;
  }

  returning(_selection: unknown): Array<{ id: number }> {
    if (!this.pendingRowValues) {
      throw new Error(`missing insert values for ${tableLabel(this.table)}`);
    }

    if (Object.is(this.table, gyms)) {
      this.fakeDb.createdGymWrites.push(this.pendingRowValues);
      return [{ id: this.fakeDb.createdGymId }];
    }

    if (Object.is(this.table, userBoards)) {
      this.fakeDb.boardWrites.push(this.pendingRowValues);
      return [{ id: this.fakeDb.createdBoardId }];
    }

    throw new Error(`unexpected returning() for ${tableLabel(this.table)}`);
  }
}

class FakeUpdateBuilder {
  private updateValues: Record<string, unknown> | null = null;

  constructor(
    private readonly fakeDb: FakeLocationSyncDb,
    private readonly table: unknown,
  ) {}

  set(nextUpdateValues: unknown): this {
    this.updateValues = rowValues(nextUpdateValues);
    return this;
  }

  where(_condition: unknown): Promise<void> {
    if (Object.is(this.table, gyms)) {
      this.fakeDb.gymMetadataWrites.push(this.updateValues ?? {});
    }
    return Promise.resolve();
  }
}

class FakeSelectBuilder {
  constructor(private readonly fakeDb: FakeLocationSyncDb) {}

  from(_table: unknown): this {
    return this;
  }

  innerJoin(_table: unknown, _condition: unknown): this {
    return this;
  }

  where(_condition: unknown): this {
    return this;
  }

  limit(_limit: number): Array<{ id: number }> {
    return this.fakeDb.aliasedGymId === null ? [] : [{ id: this.fakeDb.aliasedGymId }];
  }
}

class FakeLocationSyncDb {
  readonly systemUserWrites: Array<Record<string, unknown>> = [];
  readonly sourceAliasWrites: Array<Record<string, unknown>> = [];
  readonly createdGymWrites: Array<Record<string, unknown>> = [];
  readonly gymMetadataWrites: Array<Record<string, unknown>> = [];
  readonly boardWrites: Array<Record<string, unknown>> = [];
  readonly executeSqlTexts: string[] = [];

  readonly aliasedGymId: number | null;
  readonly physicalCandidates: CanonicalGymCandidate[];
  readonly createdGymId: number;
  readonly createdBoardId: number;

  constructor(options: {
    aliasedGymId?: number | null;
    physicalCandidates?: CanonicalGymCandidate[];
    createdGymId?: number;
    createdBoardId?: number;
  }) {
    this.aliasedGymId = options.aliasedGymId ?? null;
    this.physicalCandidates = options.physicalCandidates ?? [];
    this.createdGymId = options.createdGymId ?? 900;
    this.createdBoardId = options.createdBoardId ?? 901;
  }

  insert(table: unknown): FakeInsertBuilder {
    return new FakeInsertBuilder(this, table);
  }

  update(table: unknown): FakeUpdateBuilder {
    return new FakeUpdateBuilder(this, table);
  }

  select(_selection: unknown): FakeSelectBuilder {
    return new FakeSelectBuilder(this);
  }

  execute(query: unknown): Promise<unknown[]> {
    const queryText = sqlToText(query);
    this.executeSqlTexts.push(queryText);
    return Promise.resolve(queryText.includes('WITH candidate_gyms') ? this.physicalCandidates : []);
  }

  transaction<Result>(callback: (transaction: FakeLocationSyncDb) => Result | Promise<Result>): Promise<Result> {
    return Promise.resolve(callback(this));
  }
}

describe('location upsert planning', () => {
  it('filters records with invalid coordinates before writing', () => {
    const { validRecords, skipped } = collectValidLocationRecords([
      locationRecord({ sourceKey: 'tension:valid-board' }),
      locationRecord({ sourceKey: 'tension:missing-latitude', latitude: Number.NaN }),
      locationRecord({ sourceKey: 'tension:infinite-longitude', longitude: Number.POSITIVE_INFINITY }),
    ]);

    expect(validRecords.map((record) => record.sourceKey)).toEqual(['tension:valid-board']);
    expect(skipped).toEqual([
      { sourceKey: 'tension:missing-latitude', reason: 'invalid coordinates' },
      { sourceKey: 'tension:infinite-longitude', reason: 'invalid coordinates' },
    ]);
  });

  it('deduplicates gyms by gym source key while preserving the first gym row', () => {
    const duplicateGymRecords = [
      locationRecord({
        sourceKey: 'tension:board-1',
        gymSourceKey: 'tension:gym-shared',
        gymName: 'Original Gym Name',
      }),
      locationRecord({
        sourceKey: 'tension:board-2',
        gymSourceKey: 'tension:gym-shared',
        gymName: 'Later Gym Name',
      }),
      locationRecord({
        sourceKey: 'tension:board-3',
        gymSourceKey: 'tension:gym-other',
        gymName: 'Other Gym',
      }),
    ];

    const gymsBySource = collectUniqueGymLocationRecords(duplicateGymRecords);

    expect([...gymsBySource.keys()]).toEqual(['tension:gym-shared', 'tension:gym-other']);
    expect(gymsBySource.get('tension:gym-shared')).toMatchObject({
      sourceKey: 'tension:board-1',
      gymName: 'Original Gym Name',
    });
  });

  it('builds a write plan with valid boards, skipped records, and unique gyms', () => {
    const plan = buildLocationUpsertPlan([
      locationRecord({ sourceKey: 'tension:board-1', gymSourceKey: 'tension:gym-shared' }),
      locationRecord({ sourceKey: 'tension:board-2', gymSourceKey: 'tension:gym-shared' }),
      locationRecord({ sourceKey: 'tension:bad-board', gymSourceKey: 'tension:gym-bad', latitude: Number.NaN }),
    ]);

    expect(plan.validRecords.map((record) => record.sourceKey)).toEqual(['tension:board-1', 'tension:board-2']);
    expect([...plan.gymsBySource.keys()]).toEqual(['tension:gym-shared']);
    expect(plan.skipped).toEqual([{ sourceKey: 'tension:bad-board', reason: 'invalid coordinates' }]);
  });

  it('builds deterministic gym and board IDs with stable slugs', () => {
    const [validRecord] = collectValidLocationRecords([
      locationRecord({
        sourceKey: 'tension:board-house:123',
        gymSourceKey: 'tension:board-house',
        gymName: 'Board House',
        slugBase: 'Board House-tension',
      }),
    ]).validRecords;

    if (!validRecord) {
      throw new Error('Expected one valid location record');
    }

    const gymIdentifiers = buildGymWriteIdentifiers(validRecord.gymSourceKey, validRecord);
    const boardIdentifiers = buildBoardWriteIdentifiers(validRecord);

    expect(gymIdentifiers.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(gymIdentifiers.slug).toMatch(/^board-house-[0-9a-f]{6}$/);
    expect(boardIdentifiers.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(boardIdentifiers.slug).toMatch(/^board-house-tension-[0-9a-f]{8}$/);
    expect(buildGymWriteIdentifiers(validRecord.gymSourceKey, validRecord)).toEqual(gymIdentifiers);
    expect(buildBoardWriteIdentifiers(validRecord)).toEqual(boardIdentifiers);
  });
});

describe('public board location upsert gym resolution', () => {
  it('refreshes an existing source alias before physical matching or source upsert', async () => {
    const fakeDb = new FakeLocationSyncDb({ aliasedGymId: 42 });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({
        sourceKey: 'tension:board-aliased',
        gymSourceKey: 'tension:gym-aliased',
        gymName: 'Board House Updated',
        gymAddress: '1 Updated Lane',
        latitude: -34.12,
        longitude: 151.42,
      }),
    ]);

    expect(summary).toMatchObject({
      boardsSeen: 1,
      boardsUpserted: 1,
      gymsSeen: 1,
      gymsUpserted: 1,
    });
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toEqual([]);
    expect(fakeDb.gymMetadataWrites).toMatchObject([
      {
        name: 'Board House Updated',
        latitude: -34.12,
        longitude: 151.42,
        isPublic: true,
        deletedAt: null,
      },
    ]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(42);
    expect(fakeDb.executeSqlTexts.some((queryText) => queryText.includes('WITH candidate_gyms'))).toBe(false);
  });

  it('aliases a conservative physical match instead of creating another gym row', async () => {
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [
        candidate({ id: 87, uuid: 'less-used-gym', boardCount: 1 }),
        candidate({ id: 88, uuid: 'canonical-gym', boardCount: 5 }),
      ],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({
        sourceKey: 'tension:board-physical',
        gymSourceKey: 'tension:gym-physical',
        gymName: '  Board   House  ',
      }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'tension:gym-physical', gymId: 88 }]);
    expect(fakeDb.gymMetadataWrites).toHaveLength(1);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(88);

    const physicalMatchQueryText = fakeDb.executeSqlTexts.find((queryText) =>
      queryText.includes('WITH candidate_gyms'),
    );
    expect(physicalMatchQueryText).toMatch(/=\s+lower\(regexp_replace\(trim\(/);
  });

  it('creates a source gym and alias when no alias or physical match exists', async () => {
    const fakeDb = new FakeLocationSyncDb({ createdGymId: 123 });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'tension:board-new', gymSourceKey: 'tension:gym-new' }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Board House' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'tension:gym-new', gymId: 123 }]);
    expect(fakeDb.gymMetadataWrites).toEqual([]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(123);
  });
});
