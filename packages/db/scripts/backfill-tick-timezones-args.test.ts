import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  resolveBackfillTargetDecision,
  TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR,
} from './backfill-mislabeled-tick-timezones.js';
import { ArgError, parseReportArgs } from './report-mislabeled-tick-timezones.js';

const LOCAL_URL = 'postgresql://postgres@localhost:5432/main';
const REMOTE_URL = 'postgres://user:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require';

// `vp run db:backfill-tick-timezones -- --apply` forwards the `--` separator to
// the script verbatim, so the parser must skip it rather than reject it.
void test('a leading `--` separator is skipped, not treated as an unknown argument', () => {
  assert.equal(parseArgs(['--', '--apply']).apply, true);
});

void test('no flags is a report-only run', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.revertRunId, null);
  assert.equal(parsed.limit, null);
  assert.equal(parsed.userId, null);
  assert.deepEqual(parsed.origins, ['json_import']);
});

void test('--apply against a non-local database with the env unset is refused', () => {
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, undefined), 'remote-refused');
});

void test("only the literal '1' opts a remote run in", () => {
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, '1'), 'remote-allowed');
  // Every near-miss fails CLOSED. Copied from moonboard-import-guard.test.ts:
  // a half-set env var must never be read as consent to rewrite prod rows.
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, 'true'), 'remote-refused');
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, 'yes'), 'remote-refused');
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, ''), 'remote-refused');
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, '0'), 'remote-refused');
  assert.equal(resolveBackfillTargetDecision(REMOTE_URL, ' 1'), 'remote-refused');
});

void test('a local database never needs the override', () => {
  assert.equal(resolveBackfillTargetDecision(LOCAL_URL, undefined), 'local');
  assert.equal(resolveBackfillTargetDecision(LOCAL_URL, '1'), 'local');
});

void test('the override env var name is the one the script documents', () => {
  assert.equal(TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR, 'TICK_TZ_BACKFILL_ALLOW_REMOTE');
});

void test('an unknown flag fails loudly instead of being ignored', () => {
  assert.throws(() => parseArgs(['--aply']), ArgError);
  assert.throws(() => parseReportArgs(['--dry-run'], '2026-01-01'), ArgError);
});

// A NaN bound would match nothing and print a clean, completely false
// "0 rows to fix" — so it must fail before a connection is ever opened.
void test('a garbage --limit is rejected', () => {
  assert.throws(() => parseArgs(['--limit', 'lots']), ArgError);
  assert.throws(() => parseArgs(['--limit', '0']), ArgError);
  assert.throws(() => parseArgs(['--limit', '-5']), ArgError);
  assert.throws(() => parseArgs(['--limit', '1.5']), ArgError);
  assert.equal(parseArgs(['--limit', '250']).limit, 250);
});

void test('a garbage --batch is rejected by both scripts identically', () => {
  assert.throws(() => parseArgs(['--batch', 'NaN']), ArgError);
  assert.throws(() => parseReportArgs(['--batch', 'NaN'], '2026-01-01'), ArgError);
  assert.equal(parseArgs(['--batch', '500']).batchSize, 500);
});

void test('--origin only accepts the three known suspect cohorts', () => {
  assert.deepEqual(parseArgs(['--origin', 'json_import,aurora_pull']).origins, ['json_import', 'aurora_pull']);
  assert.deepEqual(parseArgs(['--origin', 'native_pre_cutoff']).origins, ['native_pre_cutoff']);
  assert.throws(() => parseArgs(['--origin', 'kilter_pull']), ArgError);
  assert.throws(() => parseArgs(['--origin', 'native']), ArgError);
});

void test('--revert without a run id is rejected', () => {
  assert.throws(() => parseArgs(['--revert']), ArgError);
  assert.throws(() => parseArgs(['--revert', '--apply']), ArgError);
  assert.equal(parseArgs(['--revert', 'run-1', '--apply']).revertRunId, 'run-1');
});
