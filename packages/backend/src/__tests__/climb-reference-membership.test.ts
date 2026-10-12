// A climb changing side of the publication rule (real Postgres, real client).
//
// A published, listed climb is on every device. When it becomes a draft or is
// unlisted it belongs to its owner alone, so every other device has to drop
// it, and the owner's has to keep it. When it is published or listed again
// everyone has to get it back, with its stats and grades.
//
// The first half reads what `trg_board_climbs_reference_membership` (migration
// 0270_climb_reference_membership) writes. The second half runs the offline engine's real `pullSync`
// against the real resolvers, one SQLite database per device, and reads what
// each device ends up holding.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import type { QueryInvalidator } from '@boardsesh/offline-sync';
import { pullSync, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const SCOPE_KEY = `${BOARD_TYPE}:${LAYOUT_ID}:${SIZE_ID}`;
const OWNER_ID = 'membership-owner';
const OTHER_ID = 'membership-other';
const CLIMB = 'membership-climb';
const CONTROL_CLIMB = 'membership-control';
// Long before any test clock, so a seeded row is older than any marker.
const SEEDED_AT = '2026-05-01T00:00:00Z';

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

type ClimbState = { isDraft: boolean; isListed: boolean; ownerId?: string | null };

async function seedClimb(uuid: string, state: ClimbState, seededAt = SEEDED_AT): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, frames, is_draft, is_listed, compatible_size_ids, user_id, updated_at)
    VALUES
      (${uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${uuid}, 'p1145r12', ${state.isDraft}, ${state.isListed},
       ARRAY[${SIZE_ID}]::int[], ${state.ownerId ?? null}, ${seededAt}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
    VALUES (${BOARD_TYPE}, ${uuid}, 40, 21.5, 3, ${seededAt}::timestamp),
           (${BOARD_TYPE}, ${uuid}, 45, 22.5, 1, ${seededAt}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, confidence, ascensionist_count, model_version, coeff_version,
       computed_at)
    VALUES (${BOARD_TYPE}, ${uuid}, 40, 20, 'low', 3, 'membership-model', 'membership-coeff', ${seededAt}::timestamp)
  `);
}

type Marker = { deleted_at: string; user_id: string | null };
type CursorPosition = { at: string; seq: string };

async function markersOf(uuid: string): Promise<Marker[]> {
  return rowsFromResult<Marker>(
    await db.execute(sql`
      SELECT deleted_at::text AS deleted_at, user_id FROM sync_deletions
      WHERE table_name = 'board_climbs' AND record_id = ${uuid} ORDER BY id`),
  );
}

async function climbCursor(uuid: string): Promise<CursorPosition> {
  const [row] = rowsFromResult<CursorPosition>(
    await db.execute(sql`SELECT updated_at::text AS at, sync_seq::text AS seq FROM board_climbs WHERE uuid = ${uuid}`),
  );
  return row;
}

async function statsCursors(uuid: string): Promise<CursorPosition[]> {
  return rowsFromResult<CursorPosition>(
    await db.execute(sql`
      SELECT updated_at::text AS at, sync_seq::text AS seq FROM board_climb_stats
      WHERE board_type = ${BOARD_TYPE} AND climb_uuid = ${uuid} ORDER BY angle`),
  );
}

async function gradeCursors(uuid: string): Promise<CursorPosition[]> {
  return rowsFromResult<CursorPosition>(
    await db.execute(sql`
      SELECT computed_at::text AS at, sync_seq::text AS seq FROM board_climb_grades
      WHERE board_type = ${BOARD_TYPE} AND climb_uuid = ${uuid} ORDER BY angle`),
  );
}

async function secondsBetween(earlier: string, later: string): Promise<number> {
  const [row] = rowsFromResult<{ seconds: string }>(
    await db.execute(sql`SELECT extract(epoch FROM ${later}::timestamp - ${earlier}::timestamp)::text AS seconds`),
  );
  return Number(row.seconds);
}

const setFlags = (uuid: string, state: { isDraft: boolean; isListed: boolean }) =>
  db.execute(
    sql`UPDATE board_climbs SET is_draft = ${state.isDraft}, is_listed = ${state.isListed} WHERE uuid = ${uuid}`,
  );

const PUBLISHED = { isDraft: false, isListed: true };
const DRAFT = { isDraft: true, isListed: false };
const UNLISTED = { isDraft: false, isListed: false };

describeWithDatabase('a climb changing side of the publication rule (real DB)', () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO users (id, name, email) VALUES
        (${OWNER_ID}, 'Owner', 'membership-owner@example.test'),
        (${OTHER_ID}, 'Other', 'membership-other@example.test')
      ON CONFLICT DO NOTHING
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
    await db.execute(
      sql`DELETE FROM sync_deletions WHERE table_name IN ('board_climbs', 'board_climb_stats', 'board_climb_grades')`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'membership-%'`);
    await db.execute(sql`DELETE FROM sync_deletions WHERE record_id LIKE 'membership-%'`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_ID})`);
  });

  describe('what the server writes', () => {
    it.each([
      ['becomes a draft', DRAFT],
      ['is unlisted', UNLISTED],
      ['becomes a listed draft', { isDraft: true, isListed: true }],
    ])('writes one deletion marker for every device when a published climb %s', async (_label, nextState) => {
      await seedClimb(CLIMB, { ...PUBLISHED, ownerId: OWNER_ID });
      await setFlags(CLIMB, nextState);

      const markers = await markersOf(CLIMB);
      // The log is global: the owner's device applies it too.
      expect(markers.map((marker) => marker.user_id)).toEqual([null]);
      // Stamped one second before the new row: after every older copy, so it
      // withdraws them, and before the owner's re-delivered row, so it never
      // withdraws that one.
      expect(await secondsBetween(SEEDED_AT, markers[0].deleted_at)).toBeGreaterThan(0);
      expect(await secondsBetween(markers[0].deleted_at, (await climbCursor(CLIMB)).at)).toBe(1);
    });

    it('writes the same marker for a climb nobody owns', async () => {
      await seedClimb(CLIMB, PUBLISHED);
      await setFlags(CLIMB, UNLISTED);
      expect(await markersOf(CLIMB)).toHaveLength(1);
    });

    it.each([
      ['a draft is published', DRAFT, PUBLISHED],
      ['an unlisted climb is listed', UNLISTED, PUBLISHED],
      ['a draft becomes an unlisted climb', DRAFT, UNLISTED],
      ['an unlisted climb becomes a draft', UNLISTED, DRAFT],
    ])('writes no marker when %s', async (_label, from, to) => {
      await seedClimb(CLIMB, { ...from, ownerId: OWNER_ID });
      await setFlags(CLIMB, to);
      expect(await markersOf(CLIMB)).toEqual([]);
    });

    it('writes no marker when a published climb gains an owner, loses one, or is edited', async () => {
      await seedClimb(CLIMB, PUBLISHED);
      const seeded = { stats: await statsCursors(CLIMB), grades: await gradeCursors(CLIMB) };

      await db.execute(sql`UPDATE board_climbs SET user_id = ${OWNER_ID} WHERE uuid = ${CLIMB}`);
      await db.execute(sql`UPDATE board_climbs SET name = 'Renamed' WHERE uuid = ${CLIMB}`);
      await db.execute(sql`UPDATE board_climbs SET user_id = NULL WHERE uuid = ${CLIMB}`);

      expect(await markersOf(CLIMB)).toEqual([]);
      // Still on the side it was on, so its stats and grades stay where they are.
      expect(await statsCursors(CLIMB)).toEqual(seeded.stats);
      expect(await gradeCursors(CLIMB)).toEqual(seeded.grades);
    });

    it('writes no marker when a draft or an unlisted climb is given an owner', async () => {
      await seedClimb(CLIMB, DRAFT);
      await seedClimb(CONTROL_CLIMB, UNLISTED);
      await db.execute(sql`UPDATE board_climbs SET user_id = ${OWNER_ID} WHERE uuid IN (${CLIMB}, ${CONTROL_CLIMB})`);
      expect(await markersOf(CLIMB)).toEqual([]);
      expect(await markersOf(CONTROL_CLIMB)).toEqual([]);
      for (const uuid of [CLIMB, CONTROL_CLIMB]) {
        const climb = await climbCursor(uuid);
        expect((await statsCursors(uuid)).map((row) => row.at)).toEqual([climb.at, climb.at]);
        expect((await gradeCursors(uuid)).map((row) => row.at)).toEqual([climb.at]);
      }
    });

    it.each([OTHER_ID, null])(
      'withdraws a protected climb from its former owner when ownership changes to %s',
      async (nextOwner) => {
        await seedClimb(CLIMB, { ...DRAFT, ownerId: OWNER_ID });
        await db.execute(sql`UPDATE board_climbs SET user_id = ${nextOwner} WHERE uuid = ${CLIMB}`);
        const markers = await markersOf(CLIMB);
        expect(markers.map((marker) => marker.user_id)).toEqual([OWNER_ID]);
        expect(await secondsBetween(SEEDED_AT, markers[0].deleted_at)).toBeGreaterThan(0);
      },
    );

    it('honours the bulk-import switch: no marker inside a transaction that suppresses them', async () => {
      await seedClimb(CLIMB, PUBLISHED);
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL boardsesh.suppress_sync_tombstones = 'on'`);
        await transaction.execute(sql`UPDATE board_climbs SET is_listed = false WHERE uuid = ${CLIMB}`);
      });
      expect(await markersOf(CLIMB)).toEqual([]);

      // The switch ends with its transaction.
      await setFlags(CLIMB, PUBLISHED);
      await setFlags(CLIMB, UNLISTED);
      expect(await markersOf(CLIMB)).toHaveLength(1);
    });

    it.each([
      ['leaves', PUBLISHED, DRAFT],
      ['is published', DRAFT, PUBLISHED],
    ])('moves the climb’s stats and grades to the climb’s new cursor position when it %s', async (_label, from, to) => {
      await seedClimb(CLIMB, { ...from, ownerId: OWNER_ID });
      await seedClimb(CONTROL_CLIMB, { ...from, ownerId: OWNER_ID });
      const before = { stats: await statsCursors(CLIMB), grades: await gradeCursors(CLIMB) };
      const control = { stats: await statsCursors(CONTROL_CLIMB), grades: await gradeCursors(CONTROL_CLIMB) };

      await setFlags(CLIMB, to);

      const climb = await climbCursor(CLIMB);
      const after = { stats: await statsCursors(CLIMB), grades: await gradeCursors(CLIMB) };
      expect(after.stats.map((row) => row.at)).toEqual([climb.at, climb.at]);
      expect(after.grades.map((row) => row.at)).toEqual([climb.at]);
      // A new sequence number each, so the composite cursor moves even on a
      // device whose cursor already sits at this timestamp.
      for (const [index, row] of after.stats.entries()) {
        expect(BigInt(row.seq)).toBeGreaterThan(BigInt(before.stats[index].seq));
      }
      expect(BigInt(after.grades[0].seq)).toBeGreaterThan(BigInt(before.grades[0].seq));

      // Another climb's rows are not touched.
      expect(await statsCursors(CONTROL_CLIMB)).toEqual(control.stats);
      expect(await gradeCursors(CONTROL_CLIMB)).toEqual(control.grades);
    });

    // An import worker updates climbs and may write neither the deletion log
    // nor the grades table. Its update must still succeed and still tell
    // devices, which is what SECURITY DEFINER on the function is for.
    it('works for a role that may update climbs and nothing else', async () => {
      const role = `membership_importer_${randomUUID().replaceAll('-', '')}`;
      const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      const restrictedUrl = new URL(process.env.DATABASE_URL!);
      restrictedUrl.searchParams.set('options', `-c role=${role}`);
      const restricted = postgres(restrictedUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
        await owner.unsafe(`GRANT SELECT, UPDATE ON board_climbs TO "${role}"`);
        await owner.unsafe(`GRANT USAGE ON SEQUENCE board_climbs_sync_seq_seq TO "${role}"`);
        await seedClimb(CLIMB, PUBLISHED);

        // The premise: on its own the role can write none of the three.
        await expect(restricted.unsafe(`UPDATE board_climb_grades SET local_grade = 1`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          restricted.unsafe(`INSERT INTO sync_deletions (table_name, record_id) VALUES ('board_climbs', 'x')`),
        ).rejects.toThrow(/permission denied/);

        await restricted.unsafe(`UPDATE board_climbs SET is_listed = false WHERE uuid = '${CLIMB}'`);

        const climb = await climbCursor(CLIMB);
        expect(await markersOf(CLIMB)).toHaveLength(1);
        expect((await statsCursors(CLIMB)).map((row) => row.at)).toEqual([climb.at, climb.at]);
        expect((await gradeCursors(CLIMB)).map((row) => row.at)).toEqual([climb.at]);
      } finally {
        await restricted.end();
        await owner.unsafe(`DROP OWNED BY "${role}"`);
        await owner.unsafe(`DROP ROLE "${role}"`);
        await owner.end();
      }
    });
  });

  describe('what each device ends up holding', () => {
    type Device = { database: TestSqliteDb; viewerId: string };
    type Held = {
      climb: Record<string, unknown> | null;
      statsAngles: number[];
      gradeAngles: number[];
      /** The cursor timestamps of the stats and grades rows the device holds for the climb. */
      referenceRowTimestamps: string[];
    };

    const queryClient = { invalidateQueries: () => {} } as unknown as QueryInvalidator;

    function contextFor(viewerId: string): ConnectionContext {
      return {
        connectionId: `membership-${viewerId}`,
        isAuthenticated: true,
        userId: viewerId,
        sessionId: null,
        controllerId: null,
        controllerApiKey: null,
      } as unknown as ConnectionContext;
    }

    /** The real resolvers for the board tables and the deletion stream; an empty page for everything else. */
    function fetchAs(viewerId: string) {
      return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        const context = contextFor(viewerId);
        const boardArgs = variables as Parameters<typeof syncQueries.syncClimbs>[1];
        if (query.includes('syncDeletions')) {
          const deletionArgs = variables as Parameters<typeof syncQueries.syncDeletions>[1];
          return { syncDeletions: await syncQueries.syncDeletions(undefined, deletionArgs, context) } as T;
        }
        if (query.includes('syncClimbStats')) {
          return { syncClimbStats: await syncQueries.syncClimbStats(undefined, boardArgs, context) } as T;
        }
        if (query.includes('syncClimbGrades')) {
          return { syncClimbGrades: await syncQueries.syncClimbGrades(undefined, boardArgs, context) } as T;
        }
        if (query.includes('syncClimbs')) {
          return { syncClimbs: await syncQueries.syncClimbs(undefined, boardArgs, context) } as T;
        }
        const fieldName = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/)?.[1] ?? 'unknown';
        const emptyCursor: SyncCursorInput = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
        return { [fieldName]: { documents: [], cursor: emptyCursor, hasMore: false } } as T;
      };
    }

    async function installFor(viewerId: string): Promise<Device> {
      const database = createTestDatabase();
      await runMigrations(database);
      return { database, viewerId };
    }

    const pull = (device: Device) =>
      pullSync(device.database, queryClient, fetchAs(device.viewerId), { enabledBoards: [SCOPE_KEY] });

    /** Hand the device the whole deletion stream again on its next pull. */
    const forgetDeletionCursor = (device: Device) =>
      device.database.runAsync("DELETE FROM sync_meta WHERE key = 'checkpoint:deletions'");

    async function held(device: Device, uuid: string): Promise<Held> {
      const climb = await device.database.getFirstAsync<Record<string, unknown>>(
        'SELECT uuid, is_draft, is_listed, user_id, updated_at FROM board_climbs WHERE uuid = ?',
        [uuid],
      );
      const stats = await device.database.getAllAsync<{ angle: number; at: string }>(
        'SELECT angle, updated_at AS at FROM board_climb_stats WHERE climb_uuid = ? ORDER BY angle',
        [uuid],
      );
      const grades = await device.database.getAllAsync<{ angle: number; at: string }>(
        'SELECT angle, computed_at AS at FROM board_climb_grades WHERE climb_uuid = ? ORDER BY angle',
        [uuid],
      );
      return {
        climb: climb ?? null,
        statsAngles: stats.map((row) => row.angle),
        gradeAngles: grades.map((row) => row.angle),
        referenceRowTimestamps: [...stats, ...grades].map((row) => row.at),
      };
    }

    const everything = { statsAngles: [40, 45], gradeAngles: [40] };

    it('uses a withdrawal guard that orders after variable-fraction timestamps in real SQLite', async () => {
      const [timestamp] = rowsFromResult<{ at: string }>(
        await db.execute(sql`
          SELECT (date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC')
                  - interval '3 seconds' + interval '100 milliseconds')::text AS at
        `),
      );
      await seedClimb(CLIMB, { ...PUBLISHED, ownerId: OWNER_ID }, timestamp.at);
      const device = await installFor(OTHER_ID);
      await pull(device);
      const oldTimestamp = String((await held(device, CLIMB)).climb?.updated_at);
      expect(oldTimestamp).toMatch(/\.1Z$/);
      // Within one second, numerically newer .100001Z sorts BEFORE .1Z.
      const misleadingGuard = oldTimestamp.replace('.1Z', '.100001Z');
      const comparison = await device.database.getFirstAsync<{ covered: number }>(
        'SELECT updated_at <= ? AS covered FROM board_climbs WHERE uuid = ?',
        [misleadingGuard, CLIMB],
      );
      expect(comparison?.covered).toBe(0);
      await setFlags(CLIMB, UNLISTED);
      await pull(device);
      expect((await held(device, CLIMB)).climb).toBeNull();
    });

    it.each([
      ['unpublished', DRAFT, { is_draft: 1, is_listed: 0 }],
      ['unlisted', UNLISTED, { is_draft: 0, is_listed: 0 }],
    ])(
      'when a climb is %s: other devices drop it, and its owner keeps it on a device that had it and on a fresh install',
      async (_label, nextState, storedFlags) => {
        await seedClimb(CLIMB, { ...PUBLISHED, ownerId: OWNER_ID });
        await seedClimb(CONTROL_CLIMB, PUBLISHED);
        const ownerDevice = await installFor(OWNER_ID);
        const otherDevice = await installFor(OTHER_ID);
        await pull(ownerDevice);
        await pull(otherDevice);
        expect(await held(ownerDevice, CLIMB)).toMatchObject({ climb: { is_draft: 0, is_listed: 1 }, ...everything });
        expect(await held(otherDevice, CLIMB)).toMatchObject({ climb: { is_draft: 0, is_listed: 1 }, ...everything });

        await setFlags(CLIMB, nextState);

        // Everyone else: the climb is gone, and the one beside it is not.
        await pull(otherDevice);
        expect((await held(otherDevice, CLIMB)).climb).toBeNull();
        expect(await held(otherDevice, CONTROL_CLIMB)).toMatchObject({ climb: { uuid: CONTROL_CLIMB }, ...everything });

        // The owner's device that had it: the same pull applies the marker to
        // the old copy and stores the new row, with its stats and grades.
        await pull(ownerDevice);
        const ownerRow = { uuid: CLIMB, user_id: OWNER_ID, ...storedFlags };
        const ownerHolds = await held(ownerDevice, CLIMB);
        expect(ownerHolds).toMatchObject({ climb: ownerRow, ...everything });
        // Its stats and grades were delivered again, at the climb's new
        // position: these are not the rows the device had before.
        expect(new Set(ownerHolds.referenceRowTimestamps)).toEqual(new Set([ownerHolds.climb?.updated_at]));
        expect(ownerHolds.climb?.updated_at).not.toBe(SEEDED_AT);

        // Later pulls, and the whole deletion stream handed over again, leave it there.
        await pull(ownerDevice);
        await forgetDeletionCursor(ownerDevice);
        await pull(ownerDevice);
        expect(await held(ownerDevice, CLIMB)).toMatchObject({ climb: ownerRow, ...everything });

        // A fresh install: the owner gets it, anyone else never sees it.
        const ownerNewDevice = await installFor(OWNER_ID);
        const otherNewDevice = await installFor(OTHER_ID);
        await pull(ownerNewDevice);
        await pull(otherNewDevice);
        expect(await held(ownerNewDevice, CLIMB)).toMatchObject({ climb: ownerRow, ...everything });
        expect(await held(otherNewDevice, CLIMB)).toEqual({
          climb: null,
          statsAngles: [],
          gradeAngles: [],
          referenceRowTimestamps: [],
        });
      },
    );

    it.each([DRAFT, UNLISTED])('delivers backfilled dependents past an existing device cursor: %j', async (state) => {
      await seedClimb(CLIMB, state);
      await seedClimb(CONTROL_CLIMB, { ...DRAFT, ownerId: OWNER_ID });
      await db.execute(
        sql`UPDATE board_climb_stats SET updated_at = '2026-06-01'::timestamp WHERE climb_uuid = ${CONTROL_CLIMB}`,
      );
      await db.execute(
        sql`UPDATE board_climb_grades SET computed_at = '2026-06-01'::timestamp WHERE climb_uuid = ${CONTROL_CLIMB}`,
      );
      const ownerDevice = await installFor(OWNER_ID);
      await pull(ownerDevice);
      expect((await held(ownerDevice, CLIMB)).climb).toBeNull();
      const protectedArgs = {
        boardType: BOARD_TYPE,
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
        audience: 'PROTECTED' as const,
        limit: 100,
      };
      const statsBefore = await syncQueries.syncClimbStats(undefined, protectedArgs, contextFor(OWNER_ID));
      const gradesBefore = await syncQueries.syncClimbGrades(undefined, protectedArgs, contextFor(OWNER_ID));
      expect(statsBefore.documents).toHaveLength(2);
      expect(gradesBefore.documents).toHaveLength(1);
      await db.execute(sql`UPDATE board_climbs SET user_id = ${OWNER_ID} WHERE uuid = ${CLIMB}`);
      const statsDelta = await syncQueries.syncClimbStats(
        undefined,
        { ...protectedArgs, cursor: statsBefore.cursor },
        contextFor(OWNER_ID),
      );
      const gradesDelta = await syncQueries.syncClimbGrades(
        undefined,
        { ...protectedArgs, cursor: gradesBefore.cursor },
        contextFor(OWNER_ID),
      );
      expect(statsDelta.documents).toHaveLength(2);
      expect(statsDelta.documents).toEqual([
        expect.objectContaining({ climb_uuid: CLIMB }),
        expect.objectContaining({ climb_uuid: CLIMB }),
      ]);
      expect(gradesDelta.documents).toEqual([expect.objectContaining({ climb_uuid: CLIMB })]);
      await pull(ownerDevice);
      expect(await held(ownerDevice, CLIMB)).toMatchObject({ climb: { user_id: OWNER_ID }, ...everything });
      expect(await markersOf(CLIMB)).toEqual([]);
    });

    it('withdraws a transferred protected row and delivers its dependents to the new owner', async () => {
      await seedClimb(CLIMB, { ...DRAFT, ownerId: OWNER_ID });
      const oldDevice = await installFor(OWNER_ID);
      const newDevice = await installFor(OTHER_ID);
      await pull(oldDevice);
      await pull(newDevice);
      await db.execute(sql`UPDATE board_climbs SET user_id = ${OTHER_ID} WHERE uuid = ${CLIMB}`);
      await pull(oldDevice);
      expect((await held(oldDevice, CLIMB)).climb).toBeNull();
      await pull(newDevice);
      expect(await held(newDevice, CLIMB)).toMatchObject({ climb: { user_id: OTHER_ID }, ...everything });
      await forgetDeletionCursor(newDevice);
      await pull(newDevice);
      expect(await held(newDevice, CLIMB)).toMatchObject({ climb: { user_id: OTHER_ID }, ...everything });
    });

    it('when the climb is published again: every device gets it back, with its stats and grades', async () => {
      await seedClimb(CLIMB, { ...PUBLISHED, ownerId: OWNER_ID });
      const ownerDevice = await installFor(OWNER_ID);
      const otherDevice = await installFor(OTHER_ID);
      await pull(ownerDevice);
      await pull(otherDevice);
      await setFlags(CLIMB, DRAFT);
      await pull(ownerDevice);
      await pull(otherDevice);
      expect((await held(otherDevice, CLIMB)).climb).toBeNull();
      // The marker removes the climb's own row. Removing its stats and grades
      // rows with it is the device's part; done by hand here, so that what the
      // next pull holds is what the server delivered and nothing left over.
      await otherDevice.database.runAsync('DELETE FROM board_climb_stats WHERE climb_uuid = ?', [CLIMB]);
      await otherDevice.database.runAsync('DELETE FROM board_climb_grades WHERE climb_uuid = ?', [CLIMB]);

      await setFlags(CLIMB, PUBLISHED);

      const published = { uuid: CLIMB, is_draft: 0, is_listed: 1, user_id: OWNER_ID };
      await pull(otherDevice);
      expect(await held(otherDevice, CLIMB)).toMatchObject({ climb: published, ...everything });
      await pull(ownerDevice);
      expect(await held(ownerDevice, CLIMB)).toMatchObject({ climb: published, ...everything });

      // The marker from when it left is still in the stream, and older than the
      // row: handed over again, it deletes nothing.
      expect(await markersOf(CLIMB)).toHaveLength(1);
      await forgetDeletionCursor(otherDevice);
      await pull(otherDevice);
      expect(await held(otherDevice, CLIMB)).toMatchObject({ climb: published, ...everything });

      const newDevice = await installFor(OTHER_ID);
      await pull(newDevice);
      expect(await held(newDevice, CLIMB)).toMatchObject({ climb: published, ...everything });
    });

    // Why the marker is back-dated. A device deletes a row that is no newer
    // than the marker, a tie included. A marker stamped at the row's own new
    // timestamp, met again after the owner's device stored the new row, would
    // delete it, and nothing would ever send it again.
    it('a marker at the row’s own timestamp would delete the owner’s row for good', async () => {
      await seedClimb(CLIMB, { ...PUBLISHED, ownerId: OWNER_ID });
      const ownerDevice = await installFor(OWNER_ID);
      await pull(ownerDevice);
      await setFlags(CLIMB, DRAFT);
      await pull(ownerDevice);
      expect((await held(ownerDevice, CLIMB)).climb).not.toBeNull();

      await db.execute(sql`
        INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at)
        SELECT 'board_climbs', uuid, NULL, updated_at FROM board_climbs WHERE uuid = ${CLIMB}
      `);
      await pull(ownerDevice);
      expect((await held(ownerDevice, CLIMB)).climb).toBeNull();
      await pull(ownerDevice);
      expect((await held(ownerDevice, CLIMB)).climb).toBeNull();
    });
  });
});
