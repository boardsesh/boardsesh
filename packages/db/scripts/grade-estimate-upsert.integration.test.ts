import assert from 'node:assert/strict';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { upsertGradeEstimates, type GradeEstimateRow } from './grade-estimate-upsert.js';

/**
 * The weekly MoonBoard estimate jobs must leave an unchanged row alone: same
 * xmin, same computed_at, so the offline sync cursor doesn't move and devices
 * don't download it again. Runs against a scratch database created on the
 * server MIGRATION_REPLAY_DB_URL points at (CI's db-migrations job sets it).
 *
 *   MIGRATION_REPLAY_DB_URL=postgres://postgres:password@localhost:5432/postgres \
 *     vp exec tsx --test scripts/grade-estimate-upsert.integration.test.ts
 */
const adminUrl = process.env.MIGRATION_REPLAY_DB_URL;

function estimateRows(coeffVersion: string, gradeAtZero = 18): GradeEstimateRow[] {
  return [0, 5, 70].map((angle) => {
    const localGrade = angle === 0 ? gradeAtZero : 20 + angle / 10;
    return {
      boardType: 'moonboard',
      climbUuid: 'climb-1',
      angle,
      localGrade,
      universalGrade: null,
      gradeLow: localGrade - 3,
      gradeHigh: localGrade + 3,
      confidence: 'moonboard_wide_angle_estimate',
      ascensionistCount: 0,
      contentPrior: null,
      modelVersion: 'moonboard-wide-angle-v1',
      coeffVersion,
    };
  });
}

void test('a second identical run writes zero rows and leaves the sync cursor alone', { skip: !adminUrl }, async () => {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
  const databaseName = `bs_grade_estimate_upsert_${process.pid}`;
  let client: postgres.Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const connection = new URL(adminUrl!);
    connection.pathname = `/${databaseName}`;
    client = postgres(connection.toString(), { max: 1, onnotice: () => {} });
    // Mirrors src/schema/app/climb-grades.ts: the columns and the primary key
    // the upsert's conflict target names.
    await client.unsafe(`
      CREATE TABLE board_climb_grades (
        board_type text NOT NULL,
        climb_uuid text NOT NULL,
        angle integer NOT NULL,
        local_grade double precision,
        universal_grade double precision,
        grade_low double precision,
        grade_high double precision,
        confidence text NOT NULL,
        ascensionist_count bigint NOT NULL DEFAULT 0,
        content_prior double precision,
        model_version text NOT NULL,
        coeff_version text NOT NULL,
        computed_at timestamp NOT NULL DEFAULT now(),
        sync_seq bigserial NOT NULL,
        PRIMARY KEY (board_type, climb_uuid, angle)
      )
    `);
    const db = drizzle(client);
    const snapshot = async () =>
      client!<{ angle: number; xmin: string; computed_at: string; sync_seq: string; coeff_version: string }[]>`
        SELECT angle, xmin::text, computed_at::text, sync_seq::text, coeff_version
        FROM board_climb_grades ORDER BY angle
      `;

    assert.equal(await upsertGradeEstimates(db, estimateRows('run-1'), 2), 3);
    const afterFirst = await snapshot();

    // Same values, fresh coeff_version — exactly what the weekly cron produces
    // when nothing moved.
    assert.equal(await upsertGradeEstimates(db, estimateRows('run-2'), 2), 0);
    assert.deepEqual(await snapshot(), afterFirst);

    // One real change rewrites that row only.
    assert.equal(await upsertGradeEstimates(db, estimateRows('run-3', 19), 2), 1);
    const afterChange = await snapshot();
    assert.notEqual(afterChange[0].xmin, afterFirst[0].xmin);
    assert.equal(afterChange[0].coeff_version, 'run-3');
    assert.deepEqual(afterChange.slice(1), afterFirst.slice(1));
  } finally {
    if (client) await client.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
