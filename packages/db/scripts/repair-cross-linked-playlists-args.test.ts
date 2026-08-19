import { test } from 'node:test';
import assert from 'node:assert/strict';
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
      playlist: { playlistId, playlistUuid },
    }) as CrossLinkRepairPlan;

  assert.deepEqual(countPlannedDeletions([planFor('1', 'uuid-1'), planFor('2', 'uuid-2')], attachments), {
    ownershipRows: 2,
    pins: 1,
    follows: 1,
  });
  // A refused/deferred plan never reaches this list, so the preview is zero.
  assert.deepEqual(countPlannedDeletions([], attachments), { ownershipRows: 0, pins: 0, follows: 0 });
});
