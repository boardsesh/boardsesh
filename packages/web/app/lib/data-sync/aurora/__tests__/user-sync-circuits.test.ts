// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The module imports getDb at load time, which opens a pool. Every test drives
// upsertTableData with an explicit shim db, so the real one is never used.
vi.mock('@/app/lib/db/db', () => ({ getDb: () => ({}) }));
vi.mock('../../../api-wrappers/aurora/userSync', () => ({ userSync: vi.fn() }));
vi.mock('@boardsesh/aurora-sync/apply-user-logbook', () => ({
  applyAuroraAscents: vi.fn(),
  applyAuroraBids: vi.fn(),
}));

import { boardCircuits, playlists, playlistClimbs, playlistOwnership } from '../../../db/schema';
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
type DbCall = { kind: 'select' | 'insert' | 'delete' | 'conflict' | 'execute'; table?: unknown; args: unknown[] };

function createDbShim(opts: {
  owners?: Array<Record<string, unknown>>;
  ownerResults?: Array<Array<Record<string, unknown>>>;
  returning?: Array<Record<string, unknown>>;
}) {
  const calls: DbCall[] = [];
  let selectIndex = 0;
  const db = {
    execute(statement: unknown) {
      calls.push({ kind: 'execute', args: [statement] });
      return Promise.resolve([]);
    },
    select(cols: unknown) {
      calls.push({ kind: 'select', args: [cols] });
      const rows = opts.ownerResults?.[selectIndex++] ?? opts.owners ?? [];
      const source = {
        where: () => Promise.resolve(rows),
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
            onConflictDoNothing: () => Promise.resolve(),
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
    const error = vi.fn();
    const { db, calls, insertsInto } = createDbShim({ owners: [], returning: [] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never, {
      warn: vi.fn(),
      error,
    });

    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(insertsInto(playlistClimbs)).toHaveLength(0);
    expect(calls.filter((call) => call.kind === 'delete')).toHaveLength(0);
    expect(calls.filter((call) => call.kind === 'select')).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]?.[0] ?? '{}')).toEqual({
      level: 'error',
      event: 'aurora_circuit_playlist_suppressed_without_foreign_owner',
      boardType: 'tension',
      circuitUuid: 'circuit-1',
      syncingUserId: 'user-1',
      stage: 'suppressed-upsert',
      reason: 'no-owner',
    });
  });

  it('re-reads and reports a foreign owner when the SQL guard suppresses the upsert', async () => {
    const warn = vi.fn();
    const { db, calls, insertsInto } = createDbShim({
      ownerResults: [[], [{ upstreamId: 'circuit-1', ownerUserId: 'user-2' }]],
      returning: [],
    });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never, {
      warn,
      error: vi.fn(),
    });

    expect(calls.filter((call) => call.kind === 'select')).toHaveLength(2);
    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"stage":"suppressed-upsert"');
    expect(warn.mock.calls[0]?.[0]).toContain('"reason":"foreign"');
  });

  it('takes the shared advisory locks in sorted UUID order before every source write', async () => {
    const { db, calls } = createDbShim({ owners: [], returning: [{ id: BigInt(1) }] });
    const laterCircuit = { ...circuit, uuid: 'z-circuit', name: 'later' };
    const earlierCircuit = { ...circuit, uuid: 'a-circuit', name: 'earlier' };

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [
      laterCircuit,
      earlierCircuit,
    ] as never);

    const executeCalls = calls.filter((call) => call.kind === 'execute');
    const firstInsertIndex = calls.findIndex((call) => call.kind === 'insert');
    expect(executeCalls).toHaveLength(2);
    expect(calls.slice(0, firstInsertIndex).every((call) => call.kind === 'execute')).toBe(true);
    const sourceWrites = calls
      .filter((call) => call.kind === 'insert' && call.table === boardCircuits)
      .map((call) => call.args[0] as { uuid?: string })
      .filter((row) => row.uuid === 'a-circuit' || row.uuid === 'z-circuit');
    expect(sourceWrites.map((row) => row.uuid)).toEqual(['a-circuit', 'z-circuit']);
  });

  it('filters malformed UUIDs before locks or writes and reports only a safe count', async () => {
    const error = vi.fn();
    const { db, calls } = createDbShim({ owners: [] });

    await upsertTableData(
      db as never,
      'tension',
      'circuits',
      144574,
      'user-1',
      [
        { ...circuit, uuid: 42 },
        { name: 'missing uuid', secret: 'do-not-log' },
      ] as never,
      { warn: vi.fn(), error },
    );

    expect(calls).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    const logLine = error.mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(logLine)).toEqual({
      level: 'error',
      event: 'aurora_circuit_playlist_malformed_payload',
      boardType: 'tension',
      rejectedCount: 2,
    });
    expect(logLine).not.toContain('do-not-log');
  });

  it('de-duplicates last-row-wins before locking and writing', async () => {
    const { db, calls } = createDbShim({ owners: [] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, '', [
      { ...circuit, name: 'old' },
      { ...circuit, name: 'new' },
    ] as never);

    expect(calls.filter((call) => call.kind === 'execute')).toHaveLength(1);
    const sourceInsert = calls.find((call) => call.kind === 'insert');
    expect(sourceInsert?.args[0]).toMatchObject({ uuid: 'circuit-1', name: 'new' });
  });

  it('promotes an existing viewer/editor edge to owner', async () => {
    const { db, calls } = createDbShim({ owners: [] });

    await upsertTableData(db as never, 'tension', 'circuits', 144574, 'user-1', [circuit] as never);

    const ownershipConflict = calls.find((call) => call.kind === 'conflict' && call.table === playlistOwnership)
      ?.args[0] as { set?: { role?: string } } | undefined;
    expect(ownershipConflict?.set).toEqual({ role: 'owner' });
  });
});
