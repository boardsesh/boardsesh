import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  GRADE_ESTIMATE_COMPARED_COLUMNS,
  chunkRowsByClimb,
  gradeEstimateConflictUpdate,
} from '../grade-estimate-upsert';

const dialect = new PgDialect();

void test('every overwritten value column is also in the IS DISTINCT FROM guard', () => {
  const setKeys = Object.keys(gradeEstimateConflictUpdate.set).sort();
  const compared = Object.keys(GRADE_ESTIMATE_COMPARED_COLUMNS);
  // coeff_version (minted per run) and computed_at (the sync cursor) are the
  // only columns allowed to be written without being compared.
  assert.deepEqual(setKeys, [...compared, 'coeffVersion', 'computedAt'].sort());

  const guard = dialect.sqlToQuery(gradeEstimateConflictUpdate.setWhere).sql;
  assert.match(guard, /\) IS DISTINCT FROM \(/);
  for (const column of Object.values(GRADE_ESTIMATE_COMPARED_COLUMNS)) {
    assert.ok(guard.includes(`"board_climb_grades"."${column.name}"`), `guard reads ${column.name}`);
    assert.ok(guard.includes(`EXCLUDED."${column.name}"`), `guard compares EXCLUDED.${column.name}`);
  }
  assert.ok(!guard.includes('coeff_version'), 'coeff_version changes every run and must not defeat the guard');
  assert.ok(!guard.includes('computed_at'));
});

void test('chunkRowsByClimb never splits a climb and keeps chunks within maxRows', () => {
  const ladder = (climbUuid: string, angles: number) =>
    Array.from({ length: angles }, (_, index) => ({ climbUuid, angle: index * 5 }));
  const rows = [...ladder('a', 3), ...ladder('b', 3), ...ladder('c', 2), ...ladder('d', 3)];
  const chunks = chunkRowsByClimb(rows, 7);
  assert.deepEqual(
    chunks.map((chunk) => chunk.map((row) => row.climbUuid).join('')),
    ['aaabbb', 'ccddd'],
  );
  for (const chunk of chunks) {
    for (const climbUuid of new Set(chunk.map((row) => row.climbUuid))) {
      const elsewhere = chunks.filter((other) => other !== chunk && other.some((row) => row.climbUuid === climbUuid));
      assert.equal(elsewhere.length, 0, `${climbUuid} appears in one chunk only`);
    }
  }
  assert.equal(chunks.flat().length, rows.length);
});

void test('chunkRowsByClimb gives an oversized climb its own chunk and groups non-contiguous rows', () => {
  const rows = [
    { climbUuid: 'a', angle: 0 },
    { climbUuid: 'b', angle: 0 },
    { climbUuid: 'a', angle: 5 },
    { climbUuid: 'a', angle: 10 },
  ];
  assert.deepEqual(
    chunkRowsByClimb(rows, 2).map((chunk) => chunk.map((row) => `${row.climbUuid}${row.angle}`)),
    [['a0', 'a5', 'a10'], ['b0']],
  );
  assert.deepEqual(chunkRowsByClimb([], 2), []);
  assert.throws(() => chunkRowsByClimb(rows, 0));
});
