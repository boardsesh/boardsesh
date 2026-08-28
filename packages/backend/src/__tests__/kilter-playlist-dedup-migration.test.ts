import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

import { db } from '../db/client';
import { getWorkerDatabaseUrl } from './worker-db';

// ---------------------------------------------------------------------------
// 0205_kilter_playlist_dedup_backfill — the one-time merge of the duplicate
// Kilter playlists the pre-#4707 sync created.
//
// This drives the SHIPPED migration file verbatim against a real Postgres. The
// pairing logic is a multi-CTE degree filter (unambiguous 1:1 inside a single
// sole owner) and it DELETES rows, so "I read it and it looks right" is not
// enough — a wrong merge silently destroys a user's playlist. `packages/db`
// runs on `tsx --test` and is not part of CI's vitest projects, so the
// regression test lives here, in the backend project, which is.
//
// The file is located by suffix rather than by number: `vp run db:renumber`
// moves the migration when main takes 0205, and a hardcoded name would then
// silently test nothing.
// ---------------------------------------------------------------------------

const MIGRATION_SUFFIX = '_kilter_playlist_dedup_backfill.sql';

const DRIZZLE_DIR = join(import.meta.dirname, '../../../db/drizzle');

function readMigration(): { tag: string; body: string } {
  const file = readdirSync(DRIZZLE_DIR).find((name) => name.endsWith(MIGRATION_SUFFIX));
  if (!file) throw new Error(`no migration ending in ${MIGRATION_SUFFIX} under ${DRIZZLE_DIR}`);
  const body = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
  // Read the guard tag out of the SQL rather than deriving it from the
  // filename. `vp run db:renumber` renames the file but must never rewrite a
  // tag inside a migration body, so after a renumber the two legitimately
  // disagree — and a filename-derived tag would send the idempotency assertion
  // looking for a guard row that was never written.
  const tag = /_bs_migration_guards\s+WHERE\s+tag\s*=\s*'([^']+)'/i.exec(body)?.[1];
  if (!tag) throw new Error(`could not find the _bs_migration_guards tag inside ${file}`);
  return { tag, body };
}

/**
 * Run the migration exactly as the migrator does — one multi-statement simple
 * query. Drizzle's `execute` uses the extended protocol, which refuses more
 * than one statement, so this borrows worker-db's `postgres().unsafe()`.
 */
async function applyMigration(body: string): Promise<void> {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(body);
  } finally {
    await client.end().catch(() => {});
  }
}

const USERS = [
  'dedup-u1',
  'dedup-u2',
  'dedup-u3',
  'dedup-u4',
  'dedup-u4-other',
  'dedup-u5',
  'dedup-u6',
  'dedup-u7',
  'dedup-u8',
];
const UUIDS = [
  'L1',
  'T1',
  'L2',
  'T2',
  'L3a',
  'L3b',
  'T3',
  'L4',
  'T4',
  'N5',
  'T5',
  'L6a',
  'T6a',
  'L6b',
  'T6b',
  'L7',
  'T7',
  'A8',
  'L8',
].map((u) => `dedup-${u}`);

/** drizzle expands an interpolated JS array into a tuple, not an array literal. */
function sqlList(values: string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

type Row = {
  uuid: string;
  name: string;
  aurora_id: string | null;
  kilter_id: string | null;
  marker_carried: boolean;
  untouched_updated_at: boolean;
};

async function readRows(): Promise<Map<string, Row>> {
  const result = await db.execute(sql`
    SELECT uuid, name, aurora_id, kilter_id,
           (kilter_synced_at = COALESCE(aurora_synced_at, created_at)) AS marker_carried,
           (updated_at < now() - interval '29 days') AS untouched_updated_at
    FROM playlists WHERE uuid IN (${sqlList(UUIDS)})
  `);
  return new Map(Array.from(result as Iterable<Row>).map((row) => [row.uuid, row]));
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM playlists WHERE uuid IN (${sqlList(UUIDS)})`);
  await db.execute(sql`DELETE FROM "users" WHERE id IN (${sqlList(USERS)})`);
  await db.execute(sql`DELETE FROM sync_deletions WHERE record_id IN (${sqlList(UUIDS)})`);
  // The migration is guarded by a durable row so a re-application is a no-op.
  // Drop it between tests so each one actually exercises the SQL.
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_bs_migration_guards') THEN
        DELETE FROM _bs_migration_guards WHERE tag LIKE '%_kilter_playlist_dedup_backfill';
      END IF;
    END $$
  `);
}

/** A legacy pre-split row: upstream origin in aurora_id, kilter_id still NULL. */
async function seedLegacy(args: {
  uuid: string;
  userId: string;
  auroraId: string;
  name: string;
  climbUuid?: string;
  /** Leave `aurora_synced_at` NULL — a shape the JSON import can produce. */
  noAuroraSyncedAt?: boolean;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO playlists (uuid, board_type, name, aurora_type, aurora_id, aurora_synced_at, created_at, updated_at)
    VALUES (${args.uuid}, 'kilter', ${args.name}, 'circuits', ${args.auroraId},
            CASE WHEN ${args.noAuroraSyncedAt ?? false} THEN NULL ELSE now() - interval '200 days' END,
            now() - interval '200 days', now() - interval '30 days')
  `);
  await db.execute(sql`
    INSERT INTO playlist_ownership (playlist_id, user_id, role)
    SELECT id, ${args.userId}, 'owner' FROM playlists WHERE uuid = ${args.uuid}
  `);
  if (args.climbUuid) {
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      SELECT id, ${args.climbUuid}, 40, 0 FROM playlists WHERE uuid = ${args.uuid}
    `);
  }
}

/** The twin the buggy sync inserted: kilter_id set, no aurora origin. */
async function seedTwin(args: { uuid: string; userIds: string[]; kilterId: string; name: string }): Promise<void> {
  await db.execute(sql`
    INSERT INTO playlists (uuid, board_type, name, kilter_type, kilter_id, kilter_synced_at)
    VALUES (${args.uuid}, 'kilter', ${args.name}, 'circuits', ${args.kilterId}, now())
  `);
  for (const userId of args.userIds) {
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${userId}, 'owner' FROM playlists WHERE uuid = ${args.uuid}
    `);
  }
}

/**
 * A legacy row that #4746's adoption has ALREADY merged in place: it carries
 * both its original `aurora_id` and the `kilter_id` adoption stamped onto it.
 * This shape did not exist when the migration was written and now appears in
 * production on every sync cycle, which is exactly why it needs a fixture.
 */
async function seedAdopted(args: {
  uuid: string;
  userId: string;
  auroraId: string;
  kilterId: string;
  name: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO playlists (uuid, board_type, name, aurora_type, aurora_id, aurora_synced_at,
                           kilter_type, kilter_id, kilter_synced_at, created_at, updated_at)
    VALUES (${args.uuid}, 'kilter', ${args.name}, 'circuits', ${args.auroraId},
            now() - interval '200 days', 'circuits', ${args.kilterId},
            now() - interval '200 days', now() - interval '200 days', now() - interval '30 days')
  `);
  await db.execute(sql`
    INSERT INTO playlist_ownership (playlist_id, user_id, role)
    SELECT id, ${args.userId}, 'owner' FROM playlists WHERE uuid = ${args.uuid}
  `);
}

async function seedUsers(): Promise<void> {
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${id}, ${`${id}@test.com`}, ${id}, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

describe('0205 kilter playlist dedup backfill (real DB)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('merges only unambiguous 1:1 pairs and leaves every other shape untouched', async () => {
    await seedUsers();

    // u1 — tier 1: the legacy row's aurora_id IS the circuit uuid.
    await seedLegacy({
      uuid: 'dedup-L1',
      userId: 'dedup-u1',
      auroraId: 'dedup-circ-1',
      name: 'Warmups',
      climbUuid: 'climb-A',
    });
    // The names deliberately DIFFER, so only `aurora_id = kilter_id` can pair
    // these two — otherwise tier 2 could be quietly doing tier 1's job.
    await seedTwin({ uuid: 'dedup-T1', userIds: ['dedup-u1'], kilterId: 'dedup-circ-1', name: 'Renamed On Kilter' });

    // u2 — tier 2: a JSON import rotated the id, only the name matches.
    await seedLegacy({ uuid: 'dedup-L2', userId: 'dedup-u2', auroraId: 'dedup-json-x', name: '  Projects ' });
    await seedTwin({ uuid: 'dedup-T2', userIds: ['dedup-u2'], kilterId: 'dedup-circ-2', name: 'projects' });

    // u3 — ambiguous: two legacy rows share the twin's name.
    await seedLegacy({ uuid: 'dedup-L3a', userId: 'dedup-u3', auroraId: 'dedup-json-a', name: 'Dupe' });
    await seedLegacy({ uuid: 'dedup-L3b', userId: 'dedup-u3', auroraId: 'dedup-json-b', name: 'dupe' });
    await seedTwin({ uuid: 'dedup-T3', userIds: ['dedup-u3'], kilterId: 'dedup-circ-3', name: 'Dupe' });

    // u4 — the cross-linked shape (#3541): the twin carries two owner edges.
    await seedLegacy({ uuid: 'dedup-L4', userId: 'dedup-u4', auroraId: 'dedup-circ-4', name: 'Shared' });
    await seedTwin({
      uuid: 'dedup-T4',
      userIds: ['dedup-u4', 'dedup-u4-other'],
      kilterId: 'dedup-circ-4b',
      name: 'Shared',
    });

    // u5 — a Boardsesh-native playlist sharing a name with a Kilter circuit.
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name) VALUES ('dedup-N5', 'kilter', 'Native')
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, 'dedup-u5', 'owner' FROM playlists WHERE uuid = 'dedup-N5'
    `);
    await seedTwin({ uuid: 'dedup-T5', userIds: ['dedup-u5'], kilterId: 'dedup-circ-5', name: 'Native' });

    // u6 — TWO unambiguous pairs for one user. Both must merge; the degree
    // filter is per-pair, not per-user.
    await seedLegacy({ uuid: 'dedup-L6a', userId: 'dedup-u6', auroraId: 'dedup-circ-6a', name: 'Slopers' });
    await seedTwin({ uuid: 'dedup-T6a', userIds: ['dedup-u6'], kilterId: 'dedup-circ-6a', name: 'Slopers' });
    await seedLegacy({ uuid: 'dedup-L6b', userId: 'dedup-u6', auroraId: 'dedup-json-6b', name: 'Crimps' });
    await seedTwin({ uuid: 'dedup-T6b', userIds: ['dedup-u6'], kilterId: 'dedup-circ-6b', name: 'Crimps' });

    // u7 — a legacy row with NO aurora_synced_at, so the migration's COALESCE
    // has to fall back to created_at instead of stamping NULL.
    await seedLegacy({
      uuid: 'dedup-L7',
      userId: 'dedup-u7',
      auroraId: 'dedup-circ-7',
      name: 'Pockets',
      noAuroraSyncedAt: true,
    });
    await seedTwin({ uuid: 'dedup-T7', userIds: ['dedup-u7'], kilterId: 'dedup-circ-7', name: 'Pockets' });

    await applyMigration(readMigration().body);

    const rows = await readRows();

    // Merged: the LEGACY row survives (it owns the uuid pins/follows point at),
    // gains the twin's kilter_id, and keeps its own name and climbs.
    const mergedPairs = [
      ['dedup-L1', 'dedup-T1', 'dedup-circ-1'],
      ['dedup-L2', 'dedup-T2', 'dedup-circ-2'],
      // Two pairs for one user: the 1:1 degree filter is per-pair, not per-user.
      ['dedup-L6a', 'dedup-T6a', 'dedup-circ-6a'],
      ['dedup-L6b', 'dedup-T6b', 'dedup-circ-6b'],
      // aurora_synced_at IS NULL: exercises the created_at leg of
      // COALESCE(aurora_synced_at, created_at).
      ['dedup-L7', 'dedup-T7', 'dedup-circ-7'],
    ] as const;
    for (const [legacy, twin, kilterId] of mergedPairs) {
      expect(rows.get(legacy)?.kilter_id, legacy).toBe(kilterId);
      // kilter_synced_at carries the legacy upstream content marker rather than
      // now(), or the edit-clobber guard stops reading the user's edits as local.
      expect(rows.get(legacy)?.marker_carried, legacy).toBe(true);
      // updated_at must NOT move. The whole edit-clobber guard is
      // `updated_at <= kilter_synced_at`, so a stray `updated_at = now()` in the
      // SET clause would silently hand the user's edits back to Kilter.
      expect(rows.get(legacy)?.untouched_updated_at, legacy).toBe(true);
      expect(rows.has(twin), twin).toBe(false);
    }

    // Every deleted twin is tombstoned, not just the one the focused test covers.
    const tombstoned = await db.execute(sql`
      SELECT record_id FROM sync_deletions WHERE record_id IN (${sqlList(UUIDS)})
    `);
    expect(
      Array.from(tombstoned as Iterable<{ record_id: string }>)
        .map((row) => row.record_id)
        .sort(),
    ).toEqual(mergedPairs.map(([, twin]) => twin).sort());
    expect(rows.get('dedup-L1')?.name).toBe('Warmups');
    expect(rows.get('dedup-L2')?.name).toBe('  Projects ');

    // Untouched: ambiguous, cross-linked, and Boardsesh-native.
    for (const uuid of ['dedup-L3a', 'dedup-L3b', 'dedup-L4', 'dedup-N5']) {
      expect(rows.get(uuid)?.kilter_id, uuid).toBeNull();
    }
    for (const uuid of ['dedup-T3', 'dedup-T4', 'dedup-T5']) {
      expect(rows.has(uuid), uuid).toBe(true);
    }
  });

  it('never treats a row #4746 already adopted as a deletable twin', async () => {
    // Regression for the wrong-delete path the Fable review found on #4747.
    //
    // The buggy sync's insert writes uuid/name/kilter_* and NO aurora column,
    // so a genuine twin always has `aurora_id IS NULL`. An adopted row has BOTH
    // set. Without `aurora_id IS NULL` on the twin CTE the adopted row is an
    // eligible twin, and a leftover same-named JSON-import copy pairs with it
    // as a clean 1:1 — deleting the user's real, pinned playlist and keeping
    // the import instead. Pre-#4746 this shape was degree-2 ambiguous and
    // therefore safe; adoption is what removes the ambiguity signal.
    await seedUsers();

    // The row adoption already merged: real content, real climbs, the uuid that
    // pins/follows/offline clients point at.
    await seedAdopted({
      uuid: 'dedup-A8',
      userId: 'dedup-u8',
      auroraId: 'dedup-circ-8',
      kilterId: 'dedup-circ-8',
      name: 'Sloper Session',
    });
    // A leftover JSON-import copy of the same circuit under the same owner. Its
    // aurora_id differs, so ONLY the name can pair it with anything.
    await seedLegacy({
      uuid: 'dedup-L8',
      userId: 'dedup-u8',
      auroraId: 'dedup-json-8',
      name: 'sloper session',
    });

    await applyMigration(readMigration().body);

    const rows = await readRows();

    // The adopted row must survive, keys intact.
    expect(rows.has('dedup-A8')).toBe(true);
    expect(rows.get('dedup-A8')?.kilter_id).toBe('dedup-circ-8');
    expect(rows.get('dedup-A8')?.name).toBe('Sloper Session');
    // ...and must not be tombstoned, or offline clients would drop it locally
    // even if the row itself survived.
    const tombstoned = await db.execute(sql`
      SELECT record_id FROM sync_deletions WHERE record_id = 'dedup-A8'
    `);
    expect(Array.from(tombstoned as Iterable<unknown>)).toHaveLength(0);

    // The leftover import is left exactly as it was: this migration has no
    // opinion about it, and inventing one is how the wrong delete happened.
    expect(rows.has('dedup-L8')).toBe(true);
    expect(rows.get('dedup-L8')?.kilter_id).toBeNull();
  });

  it('keeps the surviving row’s climbs', async () => {
    await seedUsers();
    await seedLegacy({
      uuid: 'dedup-L1',
      userId: 'dedup-u1',
      auroraId: 'dedup-circ-1',
      name: 'Warmups',
      climbUuid: 'climb-A',
    });
    await seedTwin({ uuid: 'dedup-T1', userIds: ['dedup-u1'], kilterId: 'dedup-circ-1', name: 'Warmups' });

    await applyMigration(readMigration().body);

    const climbs = await db.execute(sql`
      SELECT pc.climb_uuid FROM playlist_climbs pc
      JOIN playlists p ON p.id = pc.playlist_id
      WHERE p.uuid = 'dedup-L1'
    `);
    expect(Array.from(climbs as Iterable<{ climb_uuid: string }>).map((row) => row.climb_uuid)).toEqual(['climb-A']);
  });

  it('tombstones the deleted twin so offline clients drop it', async () => {
    await seedUsers();
    await seedLegacy({ uuid: 'dedup-L1', userId: 'dedup-u1', auroraId: 'dedup-circ-1', name: 'Warmups' });
    await seedTwin({ uuid: 'dedup-T1', userIds: ['dedup-u1'], kilterId: 'dedup-circ-1', name: 'Warmups' });

    await applyMigration(readMigration().body);

    const tombstones = await db.execute(sql`
      SELECT record_id, user_id FROM sync_deletions WHERE record_id = 'dedup-T1'
    `);
    const rows = Array.from(tombstones as Iterable<{ record_id: string; user_id: string }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe('dedup-u1');
  });

  it('is a no-op on re-application thanks to the guard row', async () => {
    await seedUsers();
    await seedLegacy({ uuid: 'dedup-L1', userId: 'dedup-u1', auroraId: 'dedup-circ-1', name: 'Warmups' });
    await seedTwin({ uuid: 'dedup-T1', userIds: ['dedup-u1'], kilterId: 'dedup-circ-1', name: 'Warmups' });

    const { body, tag } = readMigration();
    await applyMigration(body);

    // A second pair appears AFTER the migration ran (exactly the shape the file
    // warns is not value-idempotent). The guard row must stop it being merged.
    await seedLegacy({ uuid: 'dedup-L2', userId: 'dedup-u2', auroraId: 'dedup-circ-2', name: 'Later' });
    await seedTwin({ uuid: 'dedup-T2', userIds: ['dedup-u2'], kilterId: 'dedup-circ-2', name: 'Later' });

    await applyMigration(body);

    const rows = await readRows();
    expect(rows.has('dedup-T2')).toBe(true);
    expect(rows.get('dedup-L2')?.kilter_id).toBeNull();

    const guards = await db.execute(sql`SELECT tag FROM _bs_migration_guards WHERE tag = ${tag}`);
    expect(Array.from(guards as Iterable<{ tag: string }>)).toHaveLength(1);
  });
});
