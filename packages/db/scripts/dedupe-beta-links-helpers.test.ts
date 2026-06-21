import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  betaLinkDedupeKey,
  chooseBetaLinkToKeep,
  groupDuplicateBetaLinks,
  type BetaLinkRow,
} from './dedupe-beta-links-helpers.js';

function row(overrides: Partial<BetaLinkRow>): BetaLinkRow {
  return {
    boardType: 'kilter',
    climbUuid: 'C1',
    link: 'https://www.instagram.com/p/AAA/',
    videoIdentity: null,
    createdByUserId: null,
    tickUuid: null,
    angle: null,
    thumbnail: null,
    createdAt: null,
    ...overrides,
  };
}

test('the same shortcode across /p/ and /reel/ (and tracking params) shares a key', () => {
  const a = betaLinkDedupeKey({ boardType: 'kilter', climbUuid: 'C1', link: 'https://www.instagram.com/p/AAA/' });
  const b = betaLinkDedupeKey({ boardType: 'kilter', climbUuid: 'C1', link: 'https://instagram.com/reel/AAA/?igsh=x' });
  assert.equal(a, b);
});

test('different climb or different video do not share a key', () => {
  const base = { boardType: 'kilter', climbUuid: 'C1', link: 'https://www.instagram.com/p/AAA/' };
  assert.notEqual(betaLinkDedupeKey(base), betaLinkDedupeKey({ ...base, climbUuid: 'C2' }));
  assert.notEqual(betaLinkDedupeKey(base), betaLinkDedupeKey({ ...base, link: 'https://www.instagram.com/p/BBB/' }));
  assert.notEqual(betaLinkDedupeKey(base), betaLinkDedupeKey({ ...base, boardType: 'tension' }));
});

test('keeps the video_identity-covered row over a null Aurora row', () => {
  const aurora = row({ link: 'https://www.instagram.com/p/AAA/', videoIdentity: null });
  const attached = row({
    link: 'https://www.instagram.com/reel/AAA/',
    videoIdentity: 'instagram:AAA',
    createdByUserId: 'user-1',
  });
  const { keep, remove } = chooseBetaLinkToKeep([aurora, attached]);
  assert.equal(keep, attached);
  assert.deepEqual(remove, [aurora]);
});

test('with neither covered, a richer row (angle) beats an older but barer row', () => {
  const olderBare = row({ link: 'https://www.instagram.com/p/AAA/', createdAt: '2023-01-01', angle: null });
  const newerWithAngle = row({ link: 'https://www.instagram.com/reel/AAA/', createdAt: '2024-01-01', angle: 40 });
  const { keep } = chooseBetaLinkToKeep([olderBare, newerWithAngle]);
  assert.equal(keep, newerWithAngle);
});

test('all else equal, the oldest row is kept; link is the final deterministic tiebreak', () => {
  const older = row({ link: 'https://www.instagram.com/reel/AAA/', createdAt: '2022-05-01' });
  const newer = row({ link: 'https://www.instagram.com/p/AAA/', createdAt: '2022-06-01' });
  assert.equal(chooseBetaLinkToKeep([newer, older]).keep, older);

  const noDates = [
    row({ link: 'https://www.instagram.com/reel/AAA/' }),
    row({ link: 'https://www.instagram.com/p/AAA/' }),
  ];
  // localeCompare: '.../p/AAA/' sorts before '.../reel/AAA/'
  assert.equal(chooseBetaLinkToKeep(noDates).keep.link, 'https://www.instagram.com/p/AAA/');
});

test('groupDuplicateBetaLinks returns one group per duplicated video, keeper + removals split', () => {
  const groups = groupDuplicateBetaLinks([
    row({ climbUuid: 'C1', link: 'https://www.instagram.com/p/AAA/', createdAt: '2022-05-01' }),
    row({ climbUuid: 'C1', link: 'https://www.instagram.com/reel/AAA/', createdAt: '2022-06-01' }),
    row({ climbUuid: 'C2', link: 'https://www.instagram.com/p/BBB/' }), // unique → no group
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].remove.length, 1);
  assert.equal(groups[0].keep.link, 'https://www.instagram.com/p/AAA/');
});

test('a video legitimately attached to two different climbs is NOT a duplicate', () => {
  const groups = groupDuplicateBetaLinks([
    row({ climbUuid: 'C1', link: 'https://www.instagram.com/p/AAA/' }),
    row({ climbUuid: 'C2', link: 'https://www.instagram.com/p/AAA/' }),
  ]);
  assert.equal(groups.length, 0);
});
