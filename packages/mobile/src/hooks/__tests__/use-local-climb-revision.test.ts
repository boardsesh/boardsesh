// useLocalClimbRevision against the real DDL via node:sqlite. The React surface
// is stubbed like use-local-climb-ticks.test.ts: useQuery is a shim that runs
// the queryFn and exposes its promise.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

let db: TestSqliteDb | null;
vi.mock('../../db', () => ({ getDatabaseHandle: () => db }));

type QueryArgs<T> = { queryKey: readonly unknown[]; queryFn: () => Promise<T>; enabled?: boolean };
const lastQuery: { result: unknown; key: readonly unknown[]; ran: boolean; data: unknown } = {
  result: undefined,
  key: [],
  ran: false,
  data: undefined,
};
vi.mock('@tanstack/react-query', () => ({
  useQuery: <T>({ queryKey, queryFn, enabled }: QueryArgs<T>) => {
    lastQuery.key = queryKey;
    lastQuery.ran = enabled !== false;
    lastQuery.result = enabled === false ? Promise.resolve(undefined) : queryFn();
    return { data: lastQuery.data };
  },
}));

import { localClimbRevisionQueryKey, useLocalClimbRevision } from '../use-local-climb-revision';

async function insertClimb(uuid: string, revisionNumber: number | null, holdsRevisionNumber: number | null) {
  await db!.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, revision_number, holds_revision_number)
     VALUES (?, 'kilter', 1, ?, 1, 0, ?, ?)`,
    [uuid, uuid, revisionNumber, holdsRevisionNumber],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  lastQuery.result = undefined;
  lastQuery.data = undefined;
});

describe('useLocalClimbRevision (#6023)', () => {
  it('reads the climb’s version numbers from the phone’s copy', async () => {
    await insertClimb('edited', 4, 3);

    useLocalClimbRevision('kilter', 'edited', true);

    expect(await lastQuery.result).toEqual({ revisionNumber: 4, holdsRevisionNumber: 3 });
  });

  it.each([
    ['the phone has no row for the climb', 'not-on-phone'],
    ['the row predates the columns', 'pre-v11'],
  ])('resolves null when %s', async (_label, climbUuid) => {
    await insertClimb('pre-v11', null, null);

    useLocalClimbRevision('kilter', climbUuid, true);

    expect(await lastQuery.result).toBeNull();
  });

  it('resolves null with no database handle', async () => {
    db = null;

    useLocalClimbRevision('kilter', 'edited', true);

    expect(await lastQuery.result).toBeNull();
  });

  it.each([
    ['the caller turned it off', () => useLocalClimbRevision('kilter', 'edited', false)],
    ['there is no climb', () => useLocalClimbRevision('kilter', null, true)],
    ['the board is not resolved', () => useLocalClimbRevision(null, 'edited', true)],
  ])('does not read when %s, and hands back nothing even with a cached value', (_label, run) => {
    lastQuery.data = { revisionNumber: 9, holdsRevisionNumber: 9 };

    expect(run()).toBeUndefined();
    expect(lastQuery.ran).toBe(false);
  });

  it('hands back what the query holds while enabled, and undefined for a cached null', () => {
    lastQuery.data = { revisionNumber: 2, holdsRevisionNumber: 1 };
    expect(useLocalClimbRevision('kilter', 'edited', true)).toEqual({ revisionNumber: 2, holdsRevisionNumber: 1 });

    lastQuery.data = null;
    expect(useLocalClimbRevision('kilter', 'edited', true)).toBeUndefined();
  });

  it('keys under the climb prefix, so a climb edit and a board pull invalidate it', () => {
    expect(localClimbRevisionQueryKey('kilter', 'edited')).toEqual(['climb', 'edited', 'localRevision', 'kilter']);
  });
});
