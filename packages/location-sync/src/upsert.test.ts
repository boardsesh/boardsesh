import { describe, expect, it } from 'vitest';
import { isNull } from 'drizzle-orm';
import { gyms, locationSyncGymSources, userBoards, users } from '@boardsesh/db/schema';
import type { CanonicalGymCandidate } from '@boardsesh/db/queries';
import type { PublicBoardLocationInput } from './types';
import { boardUuidForSource, gymUuidForSource, SYSTEM_USER_ID } from './ids';
import type { LocationSyncLogger, LocationSyncLogFields } from './logger';
import {
  buildBoardWriteIdentifiers,
  buildGymWriteIdentifiers,
  buildLocationUpsertPlan,
  collectValidLocationRecords,
  collectUniqueGymLocationRecords,
  upsertPublicBoardLocations,
} from './upsert';

type UpsertDb = Parameters<typeof upsertPublicBoardLocations>[0];

const USER_OWNER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * A physical-match candidate row as {@link upsertPublicBoardLocations} reads it
 * back from the match query: the canonical fields plus the guarded-tier / alias
 * facts (distance, owner, approved-claim, existing provider aliases).
 */
type MatchCandidateRow = CanonicalGymCandidate & {
  ownerId: string;
  distanceMeters: number;
  hasApprovedClaim: boolean;
  aliasSourceKeys: string[];
};

type AliasedGymRow = {
  id: number;
  ownerId: string;
  hasApprovedClaim: boolean;
  deletedAt?: Date | null;
  syncFrozenAt?: Date | null;
  mergedIntoGymId?: number | null;
};

type CapturedLog = { message: string; fields?: LocationSyncLogFields };

function createFakeLogger(): {
  logger: LocationSyncLogger;
  debugCalls: CapturedLog[];
  infoCalls: CapturedLog[];
  warnCalls: CapturedLog[];
} {
  const debugCalls: CapturedLog[] = [];
  const infoCalls: CapturedLog[] = [];
  const warnCalls: CapturedLog[] = [];
  return {
    logger: {
      debug: (message, fields) => debugCalls.push({ message, fields }),
      info: (message, fields) => infoCalls.push({ message, fields }),
      warn: (message, fields) => warnCalls.push({ message, fields }),
    },
    debugCalls,
    infoCalls,
    warnCalls,
  };
}

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

function candidate(overrides: Partial<MatchCandidateRow>): MatchCandidateRow {
  return {
    id: 500,
    uuid: 'physical-gym',
    name: 'Board House',
    ownerId: SYSTEM_USER_ID,
    address: null,
    contactEmail: null,
    contactPhone: null,
    description: null,
    imageUrl: null,
    latitude: -33.86,
    longitude: 151.2,
    createdAt: '2026-01-01T00:00:00Z',
    // Default to a dead-on tier-1 candidate; guarded-tier tests override.
    distanceMeters: 0,
    hasApprovedClaim: false,
    aliasSourceKeys: [],
    boardCount: 0,
    memberCount: 0,
    followerCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

/**
 * Introspects a Drizzle WHERE / setWhere condition to recover the facts the
 * freeze / live-row guards depend on, WITHOUT a real SQL dialect:
 *
 *  - `columns`: the column names the condition DIRECTLY references — e.g.
 *    `sync_frozen_at` (the freeze guard) or `deleted_at` (the live-row filter).
 *    This is what makes the fake a real guardrail: a refactor that drops
 *    `isNull(gyms.syncFrozenAt)` (or `isNull(gyms.deletedAt)`) removes the column
 *    here, so the fake stops blocking the write and the guard test fails in CI.
 *  - `intParams`: the bound numeric parameters (e.g. the `gyms.id` in
 *    `eq(gyms.id, gymId)`), so the fake can tell WHICH row an UPDATE targets.
 *
 * It walks only the SQL `queryChunks`; when it hits a Column it records the name
 * and stops, so it never follows the column's `.table` back-reference (which
 * would otherwise surface every sibling column and defeat the check).
 */
function inspectCondition(condition: unknown): { columns: Set<string>; intParams: number[] } {
  const columns = new Set<string>();
  const intParams: number[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (node == null || depth > 12 || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    // A Drizzle Column: has a name + a column-type marker. Record and STOP.
    if (typeof record.name === 'string' && (record.columnType !== undefined || record.dataType !== undefined)) {
      columns.add(record.name);
      return;
    }
    // A bound Param carries an `encoder`; raw SQL-string chunks do not.
    if (record.encoder !== undefined && typeof record.value === 'number') {
      intParams.push(record.value);
    }
    const chunks = record.queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) visit(chunk, depth + 1);
      return;
    }
    if (Array.isArray(node)) {
      for (const element of node) visit(element, depth + 1);
    }
  };
  visit(condition, 0);
  return { columns, intParams };
}

class FakeInsertBuilder {
  private pendingRowValues: Record<string, unknown> | null = null;
  // Whether the ON CONFLICT DO UPDATE's setWhere references sync_frozen_at, i.e.
  // the freeze guard is present on this upsert. Captured in onConflictDoUpdate.
  private conflictSetWhereGuardsFreeze = false;

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

  onConflictDoUpdate(config: unknown): this {
    const setWhere = (config as { setWhere?: unknown } | null | undefined)?.setWhere;
    this.conflictSetWhereGuardsFreeze =
      setWhere !== undefined ? inspectCondition(setWhere).columns.has('sync_frozen_at') : false;
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
      const pendingUuid = this.pendingRowValues.uuid;
      // A frozen conflicting row is blocked by the `setWhere` guard, so the real
      // upsert returns no row — model that so the by-uuid fallback is exercised.
      // Guard-aware: only when the setWhere actually references sync_frozen_at.
      // A refactor dropping the guard would return the row here and overwrite the
      // frozen gym, which the by-uuid-fallback test then catches.
      if (
        typeof pendingUuid === 'string' &&
        this.fakeDb.frozenGymUuids.has(pendingUuid) &&
        this.conflictSetWhereGuardsFreeze
      ) {
        return [];
      }
      return [{ id: this.fakeDb.createdGymId }];
    }

    if (Object.is(this.table, userBoards)) {
      this.fakeDb.boardWrites.push(this.pendingRowValues);
      const pendingUuid = this.pendingRowValues.uuid;
      // A frozen catalog board's ON CONFLICT SET is blocked by the setWhere guard,
      // so `returning()` yields nothing and it is NOT counted in boardsUpserted —
      // the frozen row keeps its human edits. Guard-aware: a refactor dropping the
      // board setWhere returns the row here (overwrite), failing the freeze test.
      if (
        typeof pendingUuid === 'string' &&
        this.fakeDb.frozenBoardUuids.has(pendingUuid) &&
        this.conflictSetWhereGuardsFreeze
      ) {
        return [];
      }
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

  where(condition: unknown): Promise<void> {
    if (Object.is(this.table, gyms)) {
      const { columns, intParams } = inspectCondition(condition);
      const targetsFrozenGym = intParams.some((gymId) => this.fakeDb.frozenGymIds.has(gymId));
      // Model refreshSyncedGymMetadata's freeze guard: the real UPDATE's
      // `... AND sync_frozen_at IS NULL` matches 0 rows for a frozen gym, so no
      // metadata is written. If a refactor drops that guard the write lands
      // (columns no longer has sync_frozen_at), which the freeze test then catches.
      if (targetsFrozenGym && columns.has('sync_frozen_at')) {
        return Promise.resolve();
      }
      this.fakeDb.gymMetadataWrites.push(this.updateValues ?? {});
    }
    return Promise.resolve();
  }
}

class FakeSelectBuilder {
  private usedInnerJoin = false;
  private whereFiltersLiveRows = false;

  constructor(private readonly fakeDb: FakeLocationSyncDb) {}

  from(_table: unknown): this {
    return this;
  }

  innerJoin(_table: unknown, _condition: unknown): this {
    this.usedInnerJoin = true;
    return this;
  }

  where(condition: unknown): this {
    this.whereFiltersLiveRows = inspectCondition(condition).columns.has('deleted_at');
    return this;
  }

  limit(_limit: number): AliasedGymRow[] | Array<{ id: number }> {
    // The alias lookup (findAliasedGym) joins the alias table to gyms; the
    // createOrUpdateSourceGym fallback selects gyms by uuid with no join.
    if (this.usedInnerJoin) {
      return this.fakeDb.aliasedGym === null
        ? []
        : [{ deletedAt: null, syncFrozenAt: null, mergedIntoGymId: null, ...this.fakeDb.aliasedGym }];
    }
    // A soft-deleted fallback gym is excluded by the `isNull(gyms.deletedAt)`
    // filter, so it must NOT be returned — that's what keeps boards from being
    // relinked to a deleted gym. Guard-aware: if a refactor drops the deleted_at
    // filter, `whereFiltersLiveRows` is false, the deleted row is returned, and
    // the deleted-fallback test catches it.
    if (this.fakeDb.fallbackGymDeleted && this.whereFiltersLiveRows) {
      return [];
    }
    return this.fakeDb.fallbackGymId === null ? [] : [{ id: this.fakeDb.fallbackGymId }];
  }
}

class FakeLocationSyncDb {
  readonly systemUserWrites: Array<Record<string, unknown>> = [];
  readonly sourceAliasWrites: Array<Record<string, unknown>> = [];
  readonly createdGymWrites: Array<Record<string, unknown>> = [];
  readonly gymMetadataWrites: Array<Record<string, unknown>> = [];
  readonly boardWrites: Array<Record<string, unknown>> = [];
  readonly executeSqlTexts: string[] = [];

  readonly aliasedGym: AliasedGymRow | null;
  readonly physicalCandidates: MatchCandidateRow[];
  readonly createdGymId: number;
  readonly createdBoardId: number;
  // Gym uuids whose upsert is blocked by the frozen `setWhere` guard.
  readonly frozenGymUuids: Set<string>;
  // Id returned by the by-uuid fallback SELECT for a blocked (frozen) gym.
  readonly fallbackGymId: number | null;
  // Gym ids that are frozen: refreshSyncedGymMetadata's WHERE (which carries
  // `sync_frozen_at IS NULL`) matches 0 rows for these, so no metadata is written.
  readonly frozenGymIds: Set<number>;
  // Board uuids whose ON CONFLICT SET is blocked by the board `setWhere` guard.
  readonly frozenBoardUuids: Set<string>;
  // Whether the by-uuid fallback's target gym is soft-deleted. When true, the
  // `isNull(gyms.deletedAt)` filter excludes it, so the fallback resolves nothing.
  readonly fallbackGymDeleted: boolean;

  constructor(options: {
    aliasedGym?: AliasedGymRow | null;
    physicalCandidates?: MatchCandidateRow[];
    createdGymId?: number;
    createdBoardId?: number;
    frozenGymUuids?: Iterable<string>;
    fallbackGymId?: number | null;
    frozenGymIds?: Iterable<number>;
    frozenBoardUuids?: Iterable<string>;
    fallbackGymDeleted?: boolean;
  }) {
    this.aliasedGym = options.aliasedGym ?? null;
    this.physicalCandidates = options.physicalCandidates ?? [];
    this.createdGymId = options.createdGymId ?? 900;
    this.createdBoardId = options.createdBoardId ?? 901;
    this.frozenGymUuids = new Set(options.frozenGymUuids ?? []);
    this.fallbackGymId = options.fallbackGymId ?? null;
    this.frozenGymIds = new Set(options.frozenGymIds ?? []);
    this.frozenBoardUuids = new Set(options.frozenBoardUuids ?? []);
    this.fallbackGymDeleted = options.fallbackGymDeleted ?? false;
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

describe('inspectCondition sanity check', () => {
  // inspectCondition walks Drizzle's internal queryChunks/Column shape, which is
  // undocumented and could change on a Drizzle version bump. If that happens, every
  // freeze/live-row guard test above would silently stop blocking writes instead of
  // failing loudly (the fake would just never detect the guard column). Assert the
  // introspection still resolves a real column name on real Drizzle conditions, so a
  // Drizzle bump that changes the internal shape fails HERE with a clear message
  // instead of surfacing as a confusing downstream guard-test failure.
  it('recovers the column name from isNull(gyms.syncFrozenAt)', () => {
    expect(inspectCondition(isNull(gyms.syncFrozenAt)).columns.has('sync_frozen_at')).toBe(true);
  });

  it('recovers the column name from isNull(gyms.deletedAt)', () => {
    expect(inspectCondition(isNull(gyms.deletedAt)).columns.has('deleted_at')).toBe(true);
  });
});

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
  it('refreshes an existing SYSTEM-owned source alias before physical matching or source upsert', async () => {
    const fakeDb = new FakeLocationSyncDb({
      aliasedGym: { id: 42, ownerId: SYSTEM_USER_ID, hasApprovedClaim: false },
    });

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

  it('links a frozen source gym via the by-uuid fallback without overwriting it', async () => {
    const gymSourceKey = 'tension:gym-frozen';
    const frozenGymUuid = gymUuidForSource(gymSourceKey);
    const fakeDb = new FakeLocationSyncDb({
      aliasedGym: null, // no alias yet
      physicalCandidates: [], // no physical match
      frozenGymUuids: [frozenGymUuid], // the source gym already exists and is frozen
      fallbackGymId: 555, // the by-uuid fallback resolves its id
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'tension:board-frozen', gymSourceKey }),
    ]);

    // The conflicting frozen gym returned no upserted row, so its metadata was
    // never overwritten — but the fallback still resolved its id, so the alias
    // and the board both link to the existing gym.
    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: gymSourceKey, gymId: 555 }]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(555);
  });

  it('does NOT refresh metadata into a FROZEN SYSTEM-owned aliased gym (moderator-fix delta)', async () => {
    // The core delta this PR exists for: a SYSTEM-owned catalog gym a moderator
    // fixed (so it is NOT owner-curated — #3713's skip does not apply) is frozen.
    // resolveGymIdForSource still calls refreshSyncedGymMetadata, but its WHERE
    // carries `sync_frozen_at IS NULL`, so the UPDATE matches 0 rows. Drop that
    // guard and the fake writes → this test goes red.
    const fakeDb = new FakeLocationSyncDb({
      aliasedGym: { id: 700, ownerId: SYSTEM_USER_ID, hasApprovedClaim: false },
      frozenGymIds: [700],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'tension:board-frozen-sys', gymSourceKey: 'tension:gym-frozen-sys' }),
    ]);

    // No metadata write landed on the frozen gym, yet the id still resolves so
    // the board links and the sync reports the gym as seen.
    expect(fakeDb.gymMetadataWrites).toEqual([]);
    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(700);
  });

  it('does NOT overwrite a FROZEN catalog board and undercounts it in boardsUpserted', async () => {
    // A human-curated (frozen) catalog board: its ON CONFLICT SET is blocked by
    // `setWhere: isNull(userBoards.syncFrozenAt)`, so the upsert returns no row —
    // the board keeps its edits and isn't counted. Drop the board setWhere and
    // the fake returns a row (overwrite) → boardsUpserted becomes 1 → red.
    const boardSourceKey = 'tension:board-frozen-only';
    const frozenBoardUuid = boardUuidForSource(boardSourceKey);
    const fakeDb = new FakeLocationSyncDb({
      // A normal SYSTEM-owned, unfrozen gym so gym resolution succeeds and the
      // board upsert is reached.
      aliasedGym: { id: 800, ownerId: SYSTEM_USER_ID, hasApprovedClaim: false },
      frozenBoardUuids: [frozenBoardUuid],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: boardSourceKey, gymSourceKey: 'tension:gym-open' }),
    ]);

    // The frozen board's write was blocked (returned no row), so it isn't
    // counted — while the (unfrozen) gym still resolved and refreshed normally.
    expect(summary.boardsUpserted).toBe(0);
    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.gymMetadataWrites.length).toBe(1);
  });

  it('does NOT relink boards to a soft-DELETED frozen gym via the by-uuid fallback', async () => {
    // A gym the owner deleted (deleteGym freezes it + unlinks its boards). On the
    // This fixture has no persisted alias, so createOrUpdateSourceGym's setWhere
    // blocks the resurrect and falls back to the by-uuid SELECT — which is
    // filtered to LIVE rows, so it resolves nothing.
    // The source stays unlinked instead of relinking boards to the deleted gym.
    const gymSourceKey = 'tension:gym-deleted-frozen';
    const frozenGymUuid = gymUuidForSource(gymSourceKey);
    const fakeDb = new FakeLocationSyncDb({
      aliasedGym: null, // this legacy deterministic row has no source alias
      physicalCandidates: [], // nor by physical match
      frozenGymUuids: [frozenGymUuid], // the conflicting row exists and is frozen
      fallbackGymId: 999, // it WOULD resolve by uuid...
      fallbackGymDeleted: true, // ...but it's soft-deleted, so the live filter drops it
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'tension:board-deleted-frozen', gymSourceKey }),
    ]);

    // No gym resolved, no alias rewritten to the deleted gym, and the board is
    // NOT attached back to it.
    expect(summary.gymsUpserted).toBe(0);
    expect(fakeDb.sourceAliasWrites).toEqual([]);
    expect(fakeDb.boardWrites[0]?.gymId ?? null).toBeNull();
  });
});

describe('guarded second-tier gym matching', () => {
  it('prefers a tier-1 (<=20 m) candidate over a farther tier-2 candidate without a tier-2 log', async () => {
    const { logger, infoCalls, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [
        candidate({ id: 71, uuid: 'tier-two-gym', distanceMeters: 120, boardCount: 9 }),
        candidate({ id: 70, uuid: 'tier-one-gym', distanceMeters: 15, boardCount: 1 }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [locationRecord({ sourceKey: 'tension:board-t1', gymSourceKey: 'tension:gym-t1' })],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // Tier-1 wins even though the tier-2 candidate is more complete (higher board count).
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'tension:gym-t1', gymId: 70 }]);
    expect(fakeDb.gymMetadataWrites).toHaveLength(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    // Tier-1 matches stay quiet (today's behavior); only tier-2 events are logged.
    expect(infoCalls).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  it('matches an exact-name SYSTEM candidate at the 150 m tier and refreshes it', async () => {
    const { logger, infoCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [candidate({ id: 88, uuid: 'guarded-gym', distanceMeters: 140 })],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'kilter:board-guarded',
          gymSourceKey: 'kilter:gym-guarded',
          gymName: 'Board House',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-guarded', gymId: 88 }]);
    // SYSTEM-owned match still refreshes metadata.
    expect(fakeDb.gymMetadataWrites).toHaveLength(1);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(88);
    expect(infoCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('guarded-tier'),
        fields: expect.objectContaining({ gymId: 88, distanceMeters: 140 }),
      }),
    );
  });

  it('does NOT match a generic-named candidate at 150 m and logs the rejection', async () => {
    const { logger, infoCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 321,
      physicalCandidates: [candidate({ id: 90, uuid: 'generic-gym', name: 'Home Wall', distanceMeters: 130 })],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'kilter:board-generic',
          gymSourceKey: 'kilter:gym-generic',
          gymName: 'Home Wall',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // Falls through to a fresh gym; the generic candidate is never aliased.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Home Wall' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-generic', gymId: 321 }]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(321);
    expect(infoCalls).toContainEqual(expect.objectContaining({ message: expect.stringContaining('generic gym name') }));
  });

  it('still matches a generic name at tier-1 (<=20 m)', async () => {
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [candidate({ id: 91, uuid: 'generic-close', name: 'Garage', distanceMeters: 12 })],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'kilter:board-garage', gymSourceKey: 'kilter:gym-garage', gymName: 'Garage' }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-garage', gymId: 91 }]);
  });

  it('does NOT match at 150 m when a same-provider source is already aliased, and logs the rejection', async () => {
    const { logger, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 654,
      physicalCandidates: [
        candidate({
          id: 92,
          uuid: 'same-provider-gym',
          distanceMeters: 145,
          aliasSourceKeys: ['tension:gym-existing'],
        }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'tension:board-conflict',
          gymSourceKey: 'tension:gym-conflict',
          gymName: 'Board House',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // Same-provider twin 150 m away is treated as distinct: a new gym is minted.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Board House' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'tension:gym-conflict', gymId: 654 }]);
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('same-provider'),
        fields: expect.objectContaining({
          candidateGymId: 92,
          conflictingSourceKeys: ['tension:gym-existing'],
        }),
      }),
    );
  });

  it('still matches at 150 m when the only alias is the same source key (no conflict)', async () => {
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [
        candidate({ id: 93, uuid: 'resync-gym', distanceMeters: 140, aliasSourceKeys: ['tension:gym-resync'] }),
      ],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({
        sourceKey: 'tension:board-resync',
        gymSourceKey: 'tension:gym-resync',
        gymName: 'Board House',
      }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'tension:gym-resync', gymId: 93 }]);
  });

  it('binds into an approved-claim user-owned gym at the 150 m tier without touching its metadata', async () => {
    const { logger, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [
        candidate({
          id: 94,
          uuid: 'claimed-user-gym',
          ownerId: USER_OWNER_ID,
          hasApprovedClaim: true,
          distanceMeters: 60,
        }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'kilter:board-user',
          gymSourceKey: 'kilter:gym-user',
          gymName: 'Board House',
          gymAddress: '9 Sync Street',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-user', gymId: 94 }]);
    // Owner-curated fields are sacrosanct: alias written, NO metadata write.
    expect(fakeDb.gymMetadataWrites).toEqual([]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(94);
    // The initial bind into an owner-controlled gym is a security-relevant warn.
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('owner-curated gym'),
        fields: expect.objectContaining({ gymId: 94, ownerId: USER_OWNER_ID, tier: 2 }),
      }),
    );
  });

  it('skips an UNCLAIMED user-owned candidate at the 150 m tier and mints a fresh gym', async () => {
    const { logger, infoCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 940,
      physicalCandidates: [
        candidate({
          id: 94,
          uuid: 'unclaimed-user-gym',
          ownerId: USER_OWNER_ID,
          hasApprovedClaim: false,
          distanceMeters: 60,
        }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'kilter:board-unclaimed',
          gymSourceKey: 'kilter:gym-unclaimed',
          gymName: 'Board House',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // Never auto-captured: no alias into the user's gym, a fresh gym is minted.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Board House' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-unclaimed', gymId: 940 }]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(940);
    expect(infoCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('unclaimed user-owned gym'),
        fields: expect.objectContaining({ candidateGymId: 94, ownerId: USER_OWNER_ID, distanceMeters: 60 }),
      }),
    );
  });

  it('binds into a user-owned gym at tier-1 (<=20 m) without touching its metadata', async () => {
    const { logger, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [candidate({ id: 98, uuid: 'user-owned-close', ownerId: USER_OWNER_ID, distanceMeters: 12 })],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [
        locationRecord({
          sourceKey: 'kilter:board-user-close',
          gymSourceKey: 'kilter:gym-user-close',
          gymName: 'Board House',
        }),
      ],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-user-close', gymId: 98 }]);
    // Owner-curated at any tier: alias written, NO metadata write. Tier-1
    // user-owned matching needs no claim (the pin is essentially on the gym).
    expect(fakeDb.gymMetadataWrites).toEqual([]);
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('owner-curated gym'),
        fields: expect.objectContaining({ gymId: 98, ownerId: USER_OWNER_ID, tier: 1 }),
      }),
    );
  });

  it('does NOT let a generic-named user-owned gym capture a stranger pin at tier-1, and logs the near-miss', async () => {
    const { logger, infoCalls, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 981,
      physicalCandidates: [
        candidate({ id: 99, uuid: 'user-home-wall', ownerId: USER_OWNER_ID, name: 'Home Wall', distanceMeters: 15 }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [locationRecord({ sourceKey: 'kilter:board-hw', gymSourceKey: 'kilter:gym-hw', gymName: 'Home Wall' })],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // A public "Home Wall" 15 m away is NOT captured; a fresh gym is minted.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Home Wall' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-hw', gymId: 981 }]);
    // The dead-zone near-miss surfaces to humans instead of vanishing silently.
    expect(infoCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('generic-named user-owned gym'),
        fields: expect.objectContaining({ candidateGymId: 99, ownerId: USER_OWNER_ID, distanceMeters: 15 }),
      }),
    );
    expect(warnCalls).toEqual([]);
  });

  it('treats a SYSTEM gym with an approved claim as owner-curated (alias, no refresh)', async () => {
    const fakeDb = new FakeLocationSyncDb({
      physicalCandidates: [candidate({ id: 95, uuid: 'claimed-gym', hasApprovedClaim: true, distanceMeters: 10 })],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'kilter:board-claimed', gymSourceKey: 'kilter:gym-claimed', gymName: 'Board House' }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-claimed', gymId: 95 }]);
    expect(fakeDb.gymMetadataWrites).toEqual([]);
  });

  it('never refreshes metadata when an existing alias points at a user-owned gym (squat protection)', async () => {
    const fakeDb = new FakeLocationSyncDb({
      aliasedGym: { id: 96, ownerId: USER_OWNER_ID, hasApprovedClaim: false },
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({
        sourceKey: 'kilter:board-aliased-user',
        gymSourceKey: 'kilter:gym-aliased-user',
        gymName: 'Renamed By Owner',
      }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    // The alias resolves to the user's gym but the owner's fields are left alone.
    expect(fakeDb.gymMetadataWrites).toEqual([]);
    expect(fakeDb.createdGymWrites).toEqual([]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(96);
  });

  it('does NOT match a candidate just past the 150 m boundary (151 m)', async () => {
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 777,
      physicalCandidates: [candidate({ id: 97, uuid: 'too-far-gym', distanceMeters: 151 })],
    });

    const summary = await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'kilter:board-far', gymSourceKey: 'kilter:gym-far', gymName: 'Board House' }),
    ]);

    expect(summary.gymsUpserted).toBe(1);
    // Beyond the guarded radius: a fresh gym is minted, the far candidate untouched.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Board House' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-far', gymId: 777 }]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(777);
  });

  it('does NOT auto-match when two candidates sit in the 21-150 m band (ambiguous), and logs a warn', async () => {
    const { logger, warnCalls } = createFakeLogger();
    const fakeDb = new FakeLocationSyncDb({
      createdGymId: 606,
      physicalCandidates: [
        candidate({ id: 60, uuid: 'ambig-a', distanceMeters: 40, boardCount: 2 }),
        candidate({ id: 61, uuid: 'ambig-b', distanceMeters: 90, boardCount: 9 }),
      ],
    });

    const summary = await upsertPublicBoardLocations(
      fakeDb as unknown as UpsertDb,
      [locationRecord({ sourceKey: 'kilter:board-ambig', gymSourceKey: 'kilter:gym-ambig', gymName: 'Board House' })],
      { logger },
    );

    expect(summary.gymsUpserted).toBe(1);
    // Two same-name gyms inside one 150 m circle: refuse to guess, mint fresh.
    expect(fakeDb.createdGymWrites).toMatchObject([{ name: 'Board House' }]);
    expect(fakeDb.sourceAliasWrites).toMatchObject([{ sourceKey: 'kilter:gym-ambig', gymId: 606 }]);
    expect(fakeDb.boardWrites[0]?.gymId).toBe(606);
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('multiple candidates'),
        fields: expect.objectContaining({
          candidates: expect.arrayContaining([
            expect.objectContaining({ gymId: 60, distanceMeters: 40 }),
            expect.objectContaining({ gymId: 61, distanceMeters: 90 }),
          ]),
        }),
      }),
    );
  });

  it('widens the match query to include user-owned gyms and select owner + distance', async () => {
    const fakeDb = new FakeLocationSyncDb({ createdGymId: 555 });

    await upsertPublicBoardLocations(fakeDb as unknown as UpsertDb, [
      locationRecord({ sourceKey: 'kilter:board-q', gymSourceKey: 'kilter:gym-q', gymName: 'Board House' }),
    ]);

    const matchQueryText = fakeDb.executeSqlTexts.find((queryText) => queryText.includes('WITH candidate_gyms'));
    expect(matchQueryText).toBeDefined();
    // The old `owner_id = SYSTEM` filter is gone (user-owned gyms now participate)
    // and distance is computed for the tier split. The approved-claim and
    // alias-source-key columns are covered behaviorally by the owner-curated and
    // same-provider tests above, so this only asserts the two shape changes that
    // aren't otherwise observable from behavior.
    expect(matchQueryText).not.toMatch(/g\.owner_id = /);
    expect(matchQueryText).toContain('ST_Distance');
  });
});
