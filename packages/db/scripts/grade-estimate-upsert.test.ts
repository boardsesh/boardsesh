import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GRADE_ESTIMATE_COMPARED_COLUMNS, gradeEstimateConflictUpdate } from './grade-estimate-upsert.js';

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
