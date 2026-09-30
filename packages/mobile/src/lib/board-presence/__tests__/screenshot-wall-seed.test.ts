import { describe, it, expect, afterEach, vi } from 'vitest';
import type { BoardPresenceClimb, BoardPresenceEvent, Climb, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import {
  SCREENSHOT_SEED_BOARD_ID,
  buildScreenshotWallSeed,
  createScreenshotBoardPresenceClient,
  publishScreenshotWallClimbs,
} from '../screenshot-wall-seed';

function makeClimb(overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid: 'climb-1',
    name: 'Birthday Cake Trail Mix',
    grade: '6b+',
    frames: 'p1080r15p1081r12',
    angle: 40,
    setter: 'setter-a',
    sentByDisplayName: null,
    sentByAvatarUrl: null,
    sentByUserId: null,
    sentAt: '2026-07-06T00:00:00.000Z',
    seq: 100,
    ...overrides,
  };
}

// Module-level seed state persists across tests; reset it so each case starts clean.
afterEach(() => {
  publishScreenshotWallClimbs([], null);
  vi.unstubAllEnvs();
});

function makeQueueItem(climbUuid: string): ClimbQueueItemInput {
  return {
    uuid: `queue-${climbUuid}`,
    climb: {
      uuid: climbUuid,
      setter_username: 'setter-b',
      name: `Climb ${climbUuid}`,
      frames: 'p1082r13',
      angle: 40,
      ascensionist_count: 1,
      difficulty: '7a/V6',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.1',
    },
  };
}

describe('screenshot-wall-seed', () => {
  const realClimb: Climb = {
    uuid: 'real-climb-id',
    name: 'Recorded climb',
    setter_username: 'recorded-setter',
    frames: 'p1080r15p1081r12',
    angle: 40,
    ascensionist_count: 5,
    difficulty: '6b/V4',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  };

  it('carries the recorded board owner through the native wall event and stats without changing the climb', async () => {
    const owner = {
      ownerId: 'recorded-owner-id',
      ownerDisplayName: 'Recorded Owner',
      ownerAvatarUrl: 'https://cdn.example/avatar.jpg',
    };
    const seed = buildScreenshotWallSeed([realClimb], 35, owner);
    expect(seed[0]).toMatchObject({
      climbUuid: realClimb.uuid,
      name: realClimb.name,
      grade: realClimb.difficulty,
      frames: realClimb.frames,
      angle: 35,
      setter: realClimb.setter_username,
      sentByUserId: owner.ownerId,
      sentByDisplayName: owner.ownerDisplayName,
      sentByAvatarUrl: owner.ownerAvatarUrl,
    });
    publishScreenshotWallClimbs(seed, null);
    const client = createScreenshotBoardPresenceClient();
    const events: BoardPresenceEvent[] = [];
    const unsubscribe = client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));
    expect(events).toEqual([{ __typename: 'BoardClimbSet', climb: seed[0] }]);
    expect((await client.fetchStats(SCREENSHOT_SEED_BOARD_ID)).hardestSend).toMatchObject({
      sentByUserId: owner.ownerId,
      sentByDisplayName: owner.ownerDisplayName,
      sentByAvatarUrl: owner.ownerAvatarUrl,
    });
    unsubscribe();
  });

  it('keeps anonymous sender fallbacks when the board owner or optional profile fields are unavailable', () => {
    expect(buildScreenshotWallSeed([realClimb], null)[0]).toMatchObject({
      angle: realClimb.angle,
      sentByUserId: null,
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
    expect(buildScreenshotWallSeed([realClimb], null, { ownerId: 'recorded-owner-id' })[0]).toMatchObject({
      sentByUserId: 'recorded-owner-id',
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
  });

  it('exposes a non-null sentinel board id so the wall reads as live', () => {
    expect(typeof SCREENSHOT_SEED_BOARD_ID).toBe('number');
    expect(SCREENSHOT_SEED_BOARD_ID).not.toBeNull();
  });

  it('serves the published climbs from the feed methods', async () => {
    const client = createScreenshotBoardPresenceClient();
    const climbs = [makeClimb({ climbUuid: 'a', seq: 100 }), makeClimb({ climbUuid: 'b', seq: 99 })];
    publishScreenshotWallClimbs(climbs, null);

    expect(await client.fetchRecentClimbs(SCREENSHOT_SEED_BOARD_ID)).toEqual(climbs);
    expect(await client.fetchHistory(SCREENSHOT_SEED_BOARD_ID)).toEqual(climbs);
  });

  it('seeds recent senders only for a matching climb and angle', async () => {
    const client = createScreenshotBoardPresenceClient();
    publishScreenshotWallClimbs([makeClimb({ climbUuid: 'a', angle: 40 })], null);

    const senders = await client.fetchClimbRecentSenders(SCREENSHOT_SEED_BOARD_ID, 'a', 40);
    expect(senders.map((recentSender) => recentSender.displayName)).toEqual(['Alex', 'Maya', 'Sam']);
    expect(await client.fetchClimbRecentSenders(SCREENSHOT_SEED_BOARD_ID, 'a', 45)).toEqual([]);
    expect(await client.fetchClimbRecentSenders(SCREENSHOT_SEED_BOARD_ID, 'b', 40)).toEqual([]);
  });

  it('defers the one-shot fetches until the seed is published', async () => {
    const client = createScreenshotBoardPresenceClient();
    // The board-presence hook calls these once at boot, before the Climbs screen
    // publishes — they must resolve with the full data once it does, not [] early.
    const recentPromise = client.fetchRecentClimbs(SCREENSHOT_SEED_BOARD_ID);
    const statsPromise = client.fetchStats(SCREENSHOT_SEED_BOARD_ID);

    let resolvedEarly = false;
    void recentPromise.then(() => {
      resolvedEarly = true;
    });
    await Promise.resolve();
    expect(resolvedEarly).toBe(false);

    const climbs = [makeClimb({ climbUuid: 'a', grade: '7a', seq: 100 })];
    publishScreenshotWallClimbs(climbs, null);

    expect(await recentPromise).toEqual(climbs);
    expect((await statsPromise).hardestGrade).toBe('7a');
  });

  it('derives stats from the seeded climbs (hardest = the lit climb)', async () => {
    const client = createScreenshotBoardPresenceClient();
    const climbs = [makeClimb({ climbUuid: 'a', grade: '7a', seq: 100 }), makeClimb({ climbUuid: 'b', seq: 99 })];
    publishScreenshotWallClimbs(climbs, null);

    const stats = await client.fetchStats(SCREENSHOT_SEED_BOARD_ID);
    expect(stats.climbsSentCount).toBe(2);
    expect(stats.distinctClimbersCount).toBe(1);
    expect(stats.hardestGrade).toBe('7a');
    expect(stats.hardestSend?.climbUuid).toBe('a');
  });

  it('emits the current climb on subscribe and re-emits on later publishes', () => {
    const client = createScreenshotBoardPresenceClient();
    const events: BoardPresenceEvent[] = [];

    // Publish before subscribing: the initial emit should deliver it.
    publishScreenshotWallClimbs([makeClimb({ climbUuid: 'first', seq: 100 })], null);
    const unsubscribe = client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ __typename: 'BoardClimbSet', climb: expect.objectContaining({ climbUuid: 'first' }) });

    // A later publish re-emits to the live subscriber.
    publishScreenshotWallClimbs([makeClimb({ climbUuid: 'second', seq: 101 })], null);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ __typename: 'BoardClimbSet', climb: expect.objectContaining({ climbUuid: 'second' }) });

    // After unsubscribe, further publishes are not delivered.
    unsubscribe();
    publishScreenshotWallClimbs([makeClimb({ climbUuid: 'third', seq: 102 })], null);
    expect(events).toHaveLength(2);
  });

  it('keeps the seeded climb lit when a report arrives without fake Bluetooth', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const client = createScreenshotBoardPresenceClient();
    publishScreenshotWallClimbs([makeClimb({ climbUuid: 'seeded', seq: 100 })], null);
    const events: BoardPresenceEvent[] = [];
    client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));

    expect(await client.reportClimb(SCREENSHOT_SEED_BOARD_ID, makeQueueItem('reported'), 40)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('lights each reported climb with a rising seq under fake Bluetooth, surviving a seed re-publish', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    const client = createScreenshotBoardPresenceClient();
    const seeded = makeClimb({
      climbUuid: 'seeded',
      seq: 100,
      sentByDisplayName: 'Recorded Owner',
      sentByUserId: 'recorded-owner-id',
    });
    publishScreenshotWallClimbs([seeded], null);
    const events: BoardPresenceEvent[] = [];
    client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));

    await client.reportClimb(SCREENSHOT_SEED_BOARD_ID, makeQueueItem('first-report'), 35);
    expect(events.at(-1)).toEqual({
      __typename: 'BoardClimbSet',
      climb: expect.objectContaining({
        climbUuid: 'first-report',
        queueItemUuid: 'queue-first-report',
        name: 'Climb first-report',
        grade: '7a/V6',
        frames: 'p1082r13',
        angle: 35,
        sentByDisplayName: 'Recorded Owner',
        sentByUserId: 'recorded-owner-id',
      }),
    });
    const firstSeq = (events.at(-1) as { climb: BoardPresenceClimb }).climb.seq;
    expect(firstSeq).toBeGreaterThan(100);

    // The Climbs screen re-publishing the seed must not rewind the numbering,
    // or the reducer would drop the next report as stale.
    publishScreenshotWallClimbs([seeded], null);
    await client.reportClimb(SCREENSHOT_SEED_BOARD_ID, makeQueueItem('second-report'), null);
    const second = (events.at(-1) as { climb: BoardPresenceClimb }).climb;
    expect(second.climbUuid).toBe('second-report');
    expect(second.angle).toBe(40);
    expect(second.seq).toBeGreaterThan(firstSeq);
    expect((await client.fetchRecentClimbs(SCREENSHOT_SEED_BOARD_ID)).map((climb) => climb.climbUuid)).toEqual([
      'second-report',
      'seeded',
    ]);
  });

  it('emits nothing when the seed is empty', () => {
    const client = createScreenshotBoardPresenceClient();
    const events: BoardPresenceEvent[] = [];
    client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));
    expect(events).toHaveLength(0);
  });
});
