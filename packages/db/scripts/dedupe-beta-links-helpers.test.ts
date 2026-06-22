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
    foreignUsername: null,
    angle: null,
    thumbnail: null,
    isListed: null,
    createdAt: null,
    tickUuid: null,
    boardId: null,
    shortcode: null,
    videoIdentity: null,
    createdByUserId: null,
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

test('the survivor recovers angle/thumbnail that only the duplicate carried', () => {
  // Migration 0128 backfilled video_identity onto the /reel/ variant but not the
  // angle; the /p/ variant carries the angle + thumbnail. We keep the
  // video_identity row (to stay covered by the unique index) and recover the
  // rest from the row being deleted.
  const identityRow = row({
    link: 'https://www.instagram.com/reel/AAA/',
    videoIdentity: 'instagram:AAA',
    angle: null,
    thumbnail: null,
  });
  const angleRow = row({
    link: 'https://www.instagram.com/p/AAA/',
    videoIdentity: null,
    angle: 40,
    thumbnail: 'https://cdn.example/thumb.jpg',
  });
  const { keep, remove, backfill } = chooseBetaLinkToKeep([identityRow, angleRow]);
  assert.equal(keep, identityRow);
  assert.deepEqual(remove, [angleRow]);
  assert.deepEqual(backfill, { angle: 40, thumbnail: 'https://cdn.example/thumb.jpg' });
});

test('the survivor recovers tickUuid + boardId from a duplicate', () => {
  const identityRow = row({
    link: 'https://www.instagram.com/reel/AAA/',
    videoIdentity: 'instagram:AAA',
    tickUuid: null,
    boardId: null,
  });
  const tickRow = row({
    link: 'https://www.instagram.com/p/AAA/',
    videoIdentity: null,
    tickUuid: 'tick-1',
    boardId: 7,
  });
  const { keep, backfill } = chooseBetaLinkToKeep([identityRow, tickRow]);
  assert.equal(keep, identityRow);
  assert.deepEqual(backfill, { tickUuid: 'tick-1', boardId: 7 });
});

test('isListed=false is recovered (false is a value, not "missing")', () => {
  const groups = groupDuplicateBetaLinks([
    row({ link: 'https://www.instagram.com/reel/AAA/', videoIdentity: 'instagram:AAA', isListed: null }),
    row({ link: 'https://www.instagram.com/p/AAA/', videoIdentity: null, isListed: false }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].backfill, { isListed: false });
});

test('a populated field on the survivor is never overwritten by a duplicate', () => {
  const survivor = row({ link: 'https://www.instagram.com/reel/AAA/', videoIdentity: 'instagram:AAA', angle: 25 });
  const duplicate = row({ link: 'https://www.instagram.com/p/AAA/', videoIdentity: null, angle: 40 });
  const { keep, backfill } = chooseBetaLinkToKeep([survivor, duplicate]);
  assert.equal(keep, survivor);
  assert.deepEqual(backfill, {});
});

test('a field missing from the survivor and every duplicate stays unset', () => {
  // angle is null on both rows, so there's no donor — backfill must not invent
  // a value or carry an `angle: null` entry.
  const survivor = row({ link: 'https://www.instagram.com/reel/AAA/', videoIdentity: 'instagram:AAA', angle: null });
  const duplicate = row({ link: 'https://www.instagram.com/p/AAA/', videoIdentity: null, angle: null });
  const { backfill } = chooseBetaLinkToKeep([survivor, duplicate]);
  assert.deepEqual(backfill, {});
});

test('when two duplicates supply the same field, the higher-priority one wins', () => {
  const survivor = row({ link: 'https://www.instagram.com/reel/AAA/', videoIdentity: 'instagram:AAA', angle: null });
  // Both duplicates carry an angle; the attributed one outranks the bare one, so
  // its value is the one recovered.
  const attributedDup = row({ link: 'https://www.instagram.com/p/AAA/', createdByUserId: 'user-1', angle: 35 });
  const bareDup = row({ link: 'https://www.instagram.com/tv/AAA/', angle: 50 });
  const { keep, backfill } = chooseBetaLinkToKeep([survivor, bareDup, attributedDup]);
  assert.equal(keep, survivor);
  assert.equal(backfill.angle, 35);
});
