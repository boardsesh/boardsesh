import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildExistingMoonboardWideAngleKeysSql,
  buildMoonboardWideAngleTargetSql,
  planMoonboardWideAngleEstimates,
  type MoonboardWideAngleTarget,
} from './moonboard-wide-angle-estimate-helpers.js';
import { CONFIDENCE, type GradeCoefficients } from '../src/queries/grade-model/index.js';

const dialect = new PgDialect();
const sqlText = (query: SQL): string => dialect.sqlToQuery(query).sql;

function coefficients(angleOffset: GradeCoefficients['angleOffset']): GradeCoefficients {
  return {
    coeffVersion: 'test',
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset,
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

void test('the target query reads difficulty_average and falls back to the transposed estimate', () => {
  const text = sqlText(buildMoonboardWideAngleTargetSql('', 20000));
  assert.match(text, /COALESCE\(s25\.difficulty_average, g25\.local_grade\)/);
  assert.match(text, /COALESCE\(s40\.difficulty_average, g40\.local_grade\)/);
  assert.match(text, /is_listed = true/);
  assert.match(text, /ORDER BY bc\.uuid/);
});

void test('the reap query is scoped to this job’s own tier', () => {
  const text = sqlText(buildExistingMoonboardWideAngleKeysSql());
  const { params } = dialect.sqlToQuery(buildExistingMoonboardWideAngleKeysSql());
  assert.match(text, /confidence = /);
  assert.deepEqual(params, ['moonboard', CONFIDENCE.moonboardWideAngleEstimate]);
});

void describe('planMoonboardWideAngleEstimates', () => {
  void test('plans one row per wide angle, skipping 25/40 and angles with no shape coverage', () => {
    const coeffs = coefficients({ kilter: { 'v6-8': { 40: -0.09, 0: -1.62, 45: 0.48 } } });
    const target: MoonboardWideAngleTarget = {
      climbUuid: 'climb-1',
      grade25: null,
      grade25IsReal: false,
      grade40: 22,
      grade40IsReal: true,
    };
    const plan = planMoonboardWideAngleEstimates([target], [0, 25, 40, 45, 70], coeffs, [], 'v1');
    const angles = plan.upserts.map((row) => row.angle).sort((a, b) => a - b);
    assert.deepEqual(angles, [0, 45]);
    assert.equal(plan.skipped, 1); // 70° has no kilter coverage in this fixture
  });

  void test('reaps a persisted key this run no longer wants', () => {
    const coeffs = coefficients({ kilter: { 'v6-8': { 40: -0.09, 0: -1.62 } } });
    const target: MoonboardWideAngleTarget = {
      climbUuid: 'climb-1',
      grade25: null,
      grade25IsReal: false,
      grade40: 22,
      grade40IsReal: true,
    };
    const plan = planMoonboardWideAngleEstimates(
      [target],
      [0],
      coeffs,
      [
        { climbUuid: 'climb-1', angle: 0 },
        { climbUuid: 'climb-1', angle: 60 },
      ],
      'v1',
    );
    assert.deepEqual(plan.reaps, [{ climbUuid: 'climb-1', angle: 60 }]);
  });
});
