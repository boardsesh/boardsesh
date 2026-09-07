import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageBetaLinks,
  type MoonBoardBetaVideoFile,
  type StageBetaLinksArgs,
} from './moonboard-beta-links-helpers.js';

const CLIMB_A = 'climb-uuid-a';
const CLIMB_B = 'climb-uuid-b';

function link(videoId: string, problemId: number) {
  return {
    problemId,
    videoId,
    provider: 'instagram',
    url: `https://www.instagram.com/p/${videoId}/`,
    thumbnail: `https://mbgrnv1.b-cdn.net/images/media/${problemId}_1.jpg`,
  };
}

function file(problems: Record<number, string[]>): MoonBoardBetaVideoFile {
  return {
    schemaVersion: 2,
    problems: Object.fromEntries(
      Object.entries(problems).map(([problemId, videoIds]) => [
        problemId,
        { betaVideos: videoIds.length, links: videoIds.map((videoId) => link(videoId, Number(problemId))) },
      ]),
    ),
  };
}

function stage(overrides: Partial<StageBetaLinksArgs> & { file: MoonBoardBetaVideoFile }) {
  return stageBetaLinks({
    canonicalUuidByProblemId: new Map([
      [100, CLIMB_A],
      [200, CLIMB_B],
    ]),
    existingVideoIdentities: new Set<string>(),
    ...overrides,
  });
}

void test('a resolved problem stages one row per link, with no thumbnail', () => {
  const { rows, counters } = stage({ file: file({ 100: ['AAA111', 'BBB222'] }) });

  assert.equal(counters.sourceLinks, 2);
  assert.equal(counters.staged, 2);
  assert.deepEqual(rows, [
    {
      problemId: 100,
      climbUuid: CLIMB_A,
      link: 'https://www.instagram.com/p/AAA111/',
      shortcode: 'AAA111',
      videoIdentity: 'instagram:AAA111',
    },
    {
      problemId: 100,
      climbUuid: CLIMB_A,
      link: 'https://www.instagram.com/p/BBB222/',
      shortcode: 'BBB222',
      videoIdentity: 'instagram:BBB222',
    },
  ]);
  // The capture's MoonBoard CDN thumbnail is never carried into a staged row —
  // there is nowhere for it to go, by design.
  assert.equal(Object.hasOwn(rows[0], 'thumbnail'), false);
});

void test('tracking params are stripped from the stored link', () => {
  const source = file({ 100: ['AAA111'] });
  source.problems['100'].links[0].url = 'https://www.instagram.com/reel/AAA111/?igsh=tracking';
  const { rows } = stage({ file: source });

  assert.equal(rows[0].link, 'https://www.instagram.com/reel/AAA111/');
  assert.equal(rows[0].videoIdentity, 'instagram:AAA111');
});

void test('a URL we do not accept is rejected rather than stored raw', () => {
  const source = file({ 100: ['AAA111'] });
  source.problems['100'].links[0].url = 'https://example.com/not-a-reel';
  const { rows, counters } = stage({ file: source });

  assert.equal(counters.rejectedUrl, 1);
  assert.equal(counters.staged, 0);
  assert.deepEqual(rows, []);
});

void test('links on a problem we cannot resolve are skipped and reported', () => {
  const { rows, counters, unresolvedProblemIds } = stage({ file: file({ 999: ['AAA111', 'BBB222'] }) });

  assert.equal(counters.unresolvedProblem, 2);
  assert.equal(counters.staged, 0);
  assert.deepEqual(rows, []);
  assert.deepEqual(unresolvedProblemIds, [999]);
});

void test('a video two problems claim goes to the lower problem id, deterministically', () => {
  // board_beta_links_video_identity_unique is GLOBAL: one video, one climb.
  // Object key order must not decide which climb keeps it.
  const ascending = stage({ file: file({ 100: ['SHARED'], 200: ['SHARED'] }) });
  const descending = stage({ file: file({ 200: ['SHARED'], 100: ['SHARED'] }) });

  assert.equal(ascending.counters.staged, 1);
  assert.equal(ascending.rows[0].climbUuid, CLIMB_A);
  assert.deepEqual(ascending.rows, descending.rows);
  assert.deepEqual(ascending.contestedVideoIds, [
    { videoIdentity: 'instagram:SHARED', keptProblemId: 100, droppedProblemId: 200 },
  ]);
});

void test('the same link repeated inside one problem is deduped without being reported as contested', () => {
  const { counters, contestedVideoIds } = stage({ file: file({ 100: ['AAA111', 'AAA111'] }) });

  assert.equal(counters.staged, 1);
  assert.equal(counters.duplicateInFile, 1);
  assert.deepEqual(contestedVideoIds, []);
});

void test('a video already attached in the database is left where it is', () => {
  const { rows, counters } = stage({
    file: file({ 100: ['AAA111', 'BBB222'] }),
    existingVideoIdentities: new Set(['instagram:AAA111']),
  });

  assert.equal(counters.alreadyPresent, 1);
  assert.equal(counters.staged, 1);
  assert.deepEqual(
    rows.map((row) => row.videoIdentity),
    ['instagram:BBB222'],
  );
});

void test('an existing attachment blocks the video for every problem, not just the first', () => {
  // Otherwise the second claimant would insert it and violate the global
  // unique index mid-batch.
  const { rows, counters } = stage({
    file: file({ 100: ['SHARED'], 200: ['SHARED'] }),
    existingVideoIdentities: new Set(['instagram:SHARED']),
  });

  assert.equal(counters.alreadyPresent, 1);
  assert.equal(counters.duplicateInFile, 1);
  assert.deepEqual(rows, []);
});

void test('an unresolvable lower id does not consume a video the resolvable one needs', () => {
  // Resolution is checked before a problem claims a video. If it were not,
  // problem 999 would take SHARED and problem 100 would silently lose its beta.
  const { rows, counters } = stage({ file: file({ 999: ['SHARED'], 100: ['SHARED'] }) });

  assert.equal(counters.staged, 1);
  assert.equal(rows[0].climbUuid, CLIMB_A);
  assert.equal(counters.unresolvedProblem, 1);
});

void test('staging the same capture twice against its own output is a no-op', () => {
  // Idempotence: a re-run after a committed import must stage nothing.
  const capture = file({ 100: ['AAA111'], 200: ['BBB222'] });
  const first = stage({ file: capture });
  const second = stage({
    file: capture,
    existingVideoIdentities: new Set(first.rows.map((row) => row.videoIdentity)),
  });

  assert.equal(first.counters.staged, 2);
  assert.equal(second.counters.staged, 0);
});
