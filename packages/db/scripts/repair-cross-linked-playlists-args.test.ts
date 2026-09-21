import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countPlannedDeletions, parseArgs } from './repair-cross-linked-playlists.js';
import {
  DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES,
  type CrossLinkRepairPlan,
} from './repair-cross-linked-playlists-helpers.js';

test('defaults are read-only: no apply, no merge candidates, full scope', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    playlistIds: null,
    includeMergeCandidates: false,
    minSpreadMinutes: DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES,
    help: false,
  });
});

test('the vp-forwarded `--` separator is skipped rather than rejected', () => {
  assert.equal(parseArgs(['--', '--apply']).apply, true);
});

test('--playlist-ids accepts both `=value` and separate-argument forms', () => {
  assert.deepEqual(parseArgs(['--playlist-ids=12,34']).playlistIds, ['12', '34']);
  assert.deepEqual(parseArgs(['--playlist-ids', ' 12 , 34 ']).playlistIds, ['12', '34']);
});

test('--min-spread-minutes overrides the default threshold', () => {
  assert.equal(parseArgs(['--min-spread-minutes=90']).minSpreadMinutes, 90);
  assert.equal(parseArgs(['--min-spread-minutes', '0']).minSpreadMinutes, 0);
});

test('--include-merge-candidates and --apply are independent opt-ins', () => {
  const parsed = parseArgs(['--apply', '--include-merge-candidates']);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.includeMergeCandidates, true);
});

test('the dry-run preview counts only the plans --apply is allowed to write', () => {
  const attachments = {
    pinnedPlaylistIds: new Set(['1', '3']),
    followedPlaylistUuids: new Set(['uuid-1']),
  };
  const planFor = (playlistId: string, playlistUuid: string): CrossLinkRepairPlan =>
    ({
      playlist: { playlistId, playlistUuid, isPublic: false },
    }) as CrossLinkRepairPlan;

  assert.deepEqual(countPlannedDeletions([planFor('1', 'uuid-1'), planFor('2', 'uuid-2')], attachments), {
    ownershipRows: 2,
    pins: 1,
    follows: 1,
  });
  // A refused/deferred plan never reaches this list, so the preview is zero.
  assert.deepEqual(countPlannedDeletions([], attachments), { ownershipRows: 0, pins: 0, follows: 0 });
});

test('the dry-run deletion preview preserves public pins and follows', () => {
  const plans = [false, true].map((isPublic, index) => ({
    playlist: { playlistId: String(index), playlistUuid: `uuid-${index}`, isPublic },
  })) as CrossLinkRepairPlan[];
  assert.deepEqual(
    countPlannedDeletions(plans, {
      pinnedPlaylistIds: new Set(['0', '1']),
      followedPlaylistUuids: new Set(['uuid-0', 'uuid-1']),
    }),
    { ownershipRows: 2, pins: 1, follows: 1 },
  );
});

for (const { args, message } of [
  { args: ['--aply'], message: /Unknown argument/ },
  { args: ['--playlist-ids'], message: /requires a value/ },
  { args: ['--playlist-ids', '--apply'], message: /requires a value/ },
  { args: ['--playlist-ids='], message: /requires at least one id/ },
  { args: ['--playlist-ids', ' , '], message: /requires at least one id/ },
  { args: ['--playlist-ids', 'abc'], message: /is not a playlist id/ },
  { args: ['--min-spread-minutes'], message: /requires a value/ },
  { args: ['--min-spread-minutes=-1'], message: /requires a non-negative number/ },
  { args: ['--min-spread-minutes=NaN'], message: /requires a non-negative number/ },
  { args: ['--min-spread-minutes=Infinity'], message: /requires a non-negative number/ },
]) {
  void test(`invalid CLI arguments exit before database use: ${args.join(' ')}`, () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./repair-cross-linked-playlists.ts', import.meta.url)), ...args],
      { encoding: 'utf8', env: { ...process.env, DB_URL: 'invalid-database-url' }, timeout: 10000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  });
}
