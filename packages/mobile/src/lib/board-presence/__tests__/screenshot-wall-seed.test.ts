import { describe, it, expect, afterEach } from 'vitest';
import type { BoardPresenceClimb, BoardPresenceEvent } from '@boardsesh/shared-schema';
import {
  SCREENSHOT_SEED_BOARD_ID,
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
});

describe('screenshot-wall-seed', () => {
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

  it('emits nothing when the seed is empty', () => {
    const client = createScreenshotBoardPresenceClient();
    const events: BoardPresenceEvent[] = [];
    client.subscribeNowPlaying(SCREENSHOT_SEED_BOARD_ID, (event) => events.push(event));
    expect(events).toHaveLength(0);
  });
});
