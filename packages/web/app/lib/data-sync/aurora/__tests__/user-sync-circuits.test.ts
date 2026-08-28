// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The module imports getDb at load time, which opens a pool. Every test drives
// upsertTableData with an explicit shim db, so the real one is never used.
vi.mock('@/app/lib/db/db', () => ({ getDb: () => ({}) }));

import { playlists, playlistClimbs, playlistOwnership } from '../../../db/schema';
import { upsertTableData } from '../user-sync';

/**
 * #3526: this legacy proxy route (`/api/v1/{board}/proxy/{login,user-sync}`) is
 * the fourth writer of the circuits→playlists dual-write. `playlists.aurora_id`
 * is a GLOBAL unique index, so before the guard a second Boardsesh user linked
 * to the same Aurora account would adopt the first user's playlist, be granted
 * an `owner` edge on it, and have their climb list replaced.
 *
 * The sync daemons in `@boardsesh/aurora-sync` are the primary path; this file
 * exists because without it, deleting the guard block here passes every other
 * test in the repo.
 */
type DbCall = { kind: 'select' | 'insert' | 'delete' | 'conflict'; table?: unknown; args: unknown[] };

function createDbShim(opts: { owners?: Array<Record<string, unknown>>; returning?: Array<Record<string, unknown>> }) {
  const calls: DbCall[] = [];
  const db = {
    select(cols: unknown) {
      calls.push({ kind: 'select', args: [cols] });
      const source = {
        where: () => Promise.resolve(opts.owners ?? []),
        leftJoin: () => source,
        innerJoin: () => source,
      };
      return { from: () => source };
    },
    delete(table: unknown) {
      return {
        where: (cond: unknown) => {
          calls.push({ kind: 'delete', table, args: [cond] });
          return Promise.resolve();
        },
      };
    },
    insert(table: unknown) {
      return {
        values: (rows: unknown) => {
          calls.push({ kind: 'insert', table, args: [rows] });
          const chain = {
            onConflictDoUpdate: (conflictArgs: unknown) => {
              calls.push({ kind: 'conflict', table, args: [conflictArgs] });
              return Object.assign(Promise.resolve(), {
                returning: () => Promise.resolve(opts.returning ?? [{ id: BigInt(1) }]),
              });
            },
            onConflictDoNothing: (conflictArgs: unknown) => {
              calls.push({ kind: 'conflict', table, args: [conflictArgs] });
              return Promise.resolve();
            },
          };
          return Object.assign(Promise.resolve(), chain);
        },
      };
    },
  };
  const insertsInto = (table: unknown) => calls.filter((call) => call.kind === 'insert' && call.table === table);
  return { db, calls, insertsInto };
}

const circuit = {
  uuid: 'circuit-1',
  name: 'Their playlist',
  description: '',
  color: '',
  is_public: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  climbs: [{ climb_uuid: 'climb-A' }],
};

describe('web aurora proxy — circuits foreign-owner guard (#3526)', () => {
  it('a circuit owned by ANOTHER Boardsesh user produces no playlist write, no ownership row and no climbs delete', async () => {
    const { db, calls, insertsInto } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-2' }] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    // The board_circuits upsert still runs — it's user-scoped upstream and was
    // never the problem. The playlists dual-write must not.
    expect(insertsInto(playlists)).toHaveLength(0);
    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(insertsInto(playlistClimbs)).toHaveLength(0);
    expect(calls.filter((call) => call.kind === 'delete')).toHaveLength(0);
  });

  it('writes normally when this user is the sole owner', async () => {
    const { db, insertsInto } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    expect(insertsInto(playlists)).toHaveLength(1);
    expect(insertsInto(playlistOwnership)).toHaveLength(1);
  });

  it('refuses an already cross-linked playlist in either direction', async () => {
    const { db, insertsInto } = createDbShim({
      owners: [
        { upstreamId: 'circuit-1', ownerUserId: 'user-1' },
        { upstreamId: 'circuit-1', ownerUserId: 'user-2' },
      ],
    });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    expect(insertsInto(playlists)).toHaveLength(0);
    expect(insertsInto(playlistOwnership)).toHaveLength(0);
  });

  it('attaches the NOT EXISTS race guard to the playlist upsert', async () => {
    const { db, calls } = createDbShim({ owners: [] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    const conflictClause = calls.find((call) => call.kind === 'conflict' && call.table === playlists)?.args[0] as
      | { setWhere?: unknown }
      | undefined;
    expect(conflictClause?.setWhere).toBeDefined();
  });

  it('abandons the item when the race guard suppresses the upsert', async () => {
    const { db, calls, insertsInto } = createDbShim({ owners: [], returning: [] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(insertsInto(playlistClimbs)).toHaveLength(0);
    expect(calls.filter((call) => call.kind === 'delete')).toHaveLength(0);
  });
});

/**
 * #4023: this legacy proxy route shares the same `unique_playlist_climb`
 * (playlist_id, climb_uuid) index with the aurora-sync daemon, so it carries
 * the identical dedupe + onConflictDoNothing fix.
 */
describe('web aurora proxy — playlist_climbs idempotency (#4023)', () => {
  const circuitWithDupeClimb = {
    ...circuit,
    climbs: [
      { climb_uuid: 'climb-A', angle: 40, position: 0 },
      { climb_uuid: 'climb-A', angle: 55, position: 1 },
      { climb_uuid: 'climb-B', angle: 40, position: 2 },
    ],
  };

  it('dedupes a repeated climb_uuid within one circuit, keeping the first occurrence', async () => {
    const { db, calls } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuitWithDupeClimb] as never);

    const climbInsert = calls.find((call) => call.kind === 'insert' && call.table === playlistClimbs);
    const rows = climbInsert?.args[0] as Array<{ climbUuid: string; angle: number | null; position: number }>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { playlistId: BigInt(1), climbUuid: 'climb-A', angle: 40, position: 0 },
      { playlistId: BigInt(1), climbUuid: 'climb-B', angle: 40, position: 2 },
    ]);
  });

  it('carries onConflictDoNothing targeting (playlist_id, climb_uuid) on the playlist_climbs insert', async () => {
    const { db, calls } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    const conflictClause = calls.find((call) => call.kind === 'conflict' && call.table === playlistClimbs)?.args[0] as
      | { target?: unknown[] }
      | undefined;
    expect(conflictClause?.target).toEqual([playlistClimbs.playlistId, playlistClimbs.climbUuid]);
  });

  it('deletes playlist_climbs before inserting the new rows', async () => {
    const { db, calls } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    const deleteIdx = calls.findIndex((call) => call.kind === 'delete' && call.table === playlistClimbs);
    const insertIdx = calls.findIndex((call) => call.kind === 'insert' && call.table === playlistClimbs);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });

  it('skips non-string climb entries and issues no insert when nothing survives', async () => {
    const { db, insertsInto } = createDbShim({ owners: [{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }] });
    const circuitWithBadClimbs = { ...circuit, climbs: [{ climb_uuid: 42 }, { climb_uuid: null }] };

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuitWithBadClimbs] as never);

    expect(insertsInto(playlistClimbs)).toHaveLength(0);
  });
});
