import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH,
  MOONBOARD_BOARD_TYPE,
  buildExistingMoonboardEstimateKeysSql,
  buildMoonboardSingleAngleTargetSql,
  parseMoonboardAngleEstimateFlags,
  planMoonboardAngleEstimates,
  type MoonboardAngleEstimateKey,
  type MoonboardSingleAngleTarget,
} from './moonboard-angle-estimate-helpers.js';
import {
  CONFIDENCE,
  MOONBOARD_ANGLE_MODEL_VERSION,
  type MoonboardAngleCoefficients,
} from '../src/queries/grade-model/index.js';

const dialect = new PgDialect();
const sqlText = (query: SQL): string => dialect.sqlToQuery(query).sql;

const COEFFICIENTS: MoonboardAngleCoefficients = {
  coeffVersion: 'fit-1',
  from25: {
    'v3-5': { delta: 3, n: 200, sd: 1.5, looMaxDelta: 0 },
    all: { delta: 2, n: 900, sd: 1.2, looMaxDelta: 0 },
  },
  from40: {
    all: { delta: -2, n: 900, sd: 5, looMaxDelta: 0 },
  },
};

function target(overrides: Partial<MoonboardSingleAngleTarget> = {}): MoonboardSingleAngleTarget {
  return { climbUuid: 'climb-1', knownAngle: 25, knownGrade: 18, ...overrides };
}

void test('the target query only picks problems graded at exactly one of the two angles', () => {
  const text = sqlText(buildMoonboardSingleAngleTargetSql('', 500));
  assert.match(text, /HAVING COUNT\(\*\) = 1/);
  assert.match(text, /display_difficulty IS NOT NULL/);
  assert.match(text, /ascensionist_count > 0/);
  assert.match(text, /is_listed = true/);
  // Keyset pagination, one climb per output row.
  assert.match(text, /climb_uuid > /);
  assert.match(text, /ORDER BY s\.climb_uuid/);
});

void test('the reap query is scoped to this job’s own tier', () => {
  const text = sqlText(buildExistingMoonboardEstimateKeysSql());
  assert.match(text, /board_type = /);
  assert.match(text, /confidence = /);
  const { params } = dialect.sqlToQuery(buildExistingMoonboardEstimateKeysSql());
  assert.deepEqual(params, [MOONBOARD_BOARD_TYPE, CONFIDENCE.moonboardAngleEstimate]);
});

void test('a single-angle problem gets one estimate row at the angle it is missing', () => {
  const plan = planMoonboardAngleEstimates([target()], COEFFICIENTS, [], 'run-1');

  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.skipped, 0);
  const [row] = plan.upserts;
  assert.equal(row.boardType, MOONBOARD_BOARD_TYPE);
  assert.equal(row.climbUuid, 'climb-1');
  // Graded at 25°, so the row lands at 40° — never over the real grade.
  assert.equal(row.angle, 40);
  assert.equal(row.localGrade, 21);
  // MoonBoard has no cross-board bridge, and nobody has climbed this angle.
  assert.equal(row.universalGrade, null);
  assert.equal(row.ascensionistCount, 0);
  assert.equal(row.contentPrior, null);
  assert.equal(row.confidence, CONFIDENCE.moonboardAngleEstimate);
  assert.equal(row.modelVersion, MOONBOARD_ANGLE_MODEL_VERSION);
  assert.equal(row.coeffVersion, 'run-1');
  assert.equal(row.gradeLow, 21 - 1.5);
  assert.equal(row.gradeHigh, 21 + 1.5);
});

void test('the published band never gets wider than the drawer will print', () => {
  // The from40 cell's spread is 5 grade points; the row must still come back
  // inside the printable half-band.
  const plan = planMoonboardAngleEstimates([target({ knownAngle: 40, knownGrade: 24 })], COEFFICIENTS, [], 'run-1');
  const [row] = plan.upserts;
  assert.equal(row.angle, 25);
  assert.equal(row.localGrade, 22);
  assert.equal(row.gradeLow, 22 - MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH);
  assert.equal(row.gradeHigh, 22 + MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH);
});

void test('a dual-angle problem is a no-op: it never reaches the planner, and any old row it has is reaped', () => {
  // The target query excludes dual-angle problems structurally, so a problem
  // that has since been climbed at both angles simply stops being a target.
  const existing: MoonboardAngleEstimateKey[] = [{ climbUuid: 'now-dual', angle: 40 }];
  const plan = planMoonboardAngleEstimates([], COEFFICIENTS, existing, 'run-2');

  assert.equal(plan.upserts.length, 0);
  assert.deepEqual(plan.reaps, existing);
});

void test('reaps only the estimate rows this run stopped standing behind', () => {
  const existing: MoonboardAngleEstimateKey[] = [
    { climbUuid: 'climb-1', angle: 40 }, // still estimated → kept
    { climbUuid: 'now-dual', angle: 25 }, // gained a real grade → reaped
    { climbUuid: 'delisted', angle: 40 }, // no longer a target → reaped
  ];
  const plan = planMoonboardAngleEstimates([target()], COEFFICIENTS, existing, 'run-3');

  assert.deepEqual(plan.reaps, [
    { climbUuid: 'now-dual', angle: 25 },
    { climbUuid: 'delisted', angle: 40 },
  ]);
});

void test('a target the model cannot transpose is skipped, not written with a guessed grade', () => {
  const empty: MoonboardAngleCoefficients = { coeffVersion: 'x', from25: {}, from40: {} };
  const plan = planMoonboardAngleEstimates([target(), target({ climbUuid: 'c2', knownAngle: 15 })], empty, [], 'run-4');

  assert.equal(plan.upserts.length, 0);
  assert.equal(plan.skipped, 2);
  assert.deepEqual(plan.reaps, []);
});

void test('publishing is opt-in: no flags reports only', () => {
  assert.deepEqual(parseMoonboardAngleEstimateFlags(['node', 'script']), {
    validateOnly: false,
    dryRun: false,
    publish: false,
  });
  assert.deepEqual(parseMoonboardAngleEstimateFlags(['node', 'script', '--validate-only', '--publish']), {
    validateOnly: true,
    dryRun: false,
    publish: true,
  });
  assert.equal(parseMoonboardAngleEstimateFlags(['--dry-run']).dryRun, true);
});
