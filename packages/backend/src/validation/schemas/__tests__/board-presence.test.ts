import { describe, expect, it } from 'vitest';
import {
  BoardLayersSnapshotRedisSchema,
  BoardPresenceClimbRedisSchema,
  BoardPresenceEventRedisSchema,
  ReportBoardLayersInputSchema,
} from '../board-presence';

describe('ReportBoardLayersInputSchema', () => {
  const layer = {
    color: '#1a2b3c',
    remainingSeconds: 60,
    climbUuid: null,
    angle: null,
    geometryKnown: false,
  };

  it('accepts foreign colours and duplicate colours from controller readback', () => {
    const parsed = ReportBoardLayersInputSchema.parse([layer, layer]);
    expect(parsed.map(({ color }) => color)).toEqual(['#1A2B3C', '#1A2B3C']);
  });

  it.each(['1A2B3C', '#12345', '#GG0000'])('rejects a malformed controller colour: %s', (color) => {
    expect(ReportBoardLayersInputSchema.safeParse([{ ...layer, color }]).success).toBe(false);
  });
});

describe('board presence Redis schemas', () => {
  const redisLayer = {
    color: '#1A2B3C',
    remainingSeconds: 60,
    climbUuid: null,
    angle: null,
    geometryKnown: false,
  };

  it('accepts the server-owned history and Quantum snapshot shapes', () => {
    expect(
      BoardPresenceClimbRedisSchema.safeParse({
        climbUuid: 'climb-1',
        sentAt: '2026-08-30T00:00:00.000Z',
        seq: 1,
      }).success,
    ).toBe(true);
    expect(
      BoardLayersSnapshotRedisSchema.safeParse({
        boardId: 123,
        layers: [{ ...redisLayer, placementIds: [10, 20] }],
        observedAt: '2026-08-30T00:00:00.000Z',
        stale: false,
        seq: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects corrupt Redis values before they reach GraphQL subscribers', () => {
    expect(
      BoardPresenceClimbRedisSchema.safeParse({
        climbUuid: 'climb-1',
        sentAt: 'not-a-timestamp',
        seq: '1',
      }).success,
    ).toBe(false);
    expect(
      BoardLayersSnapshotRedisSchema.safeParse({
        boardId: 123,
        layers: [{ ...redisLayer, placementIds: ['10'] }],
        observedAt: '2026-08-30T00:00:00.000Z',
        stale: false,
        seq: 2,
      }).success,
    ).toBe(false);
    expect(
      BoardPresenceClimbRedisSchema.safeParse({
        climbUuid: 'climb-1',
        angle: 1.5,
        sentAt: '2026-08-30T00:00:00.000Z',
        seq: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects Redis integers that GraphQL cannot serialize', () => {
    const aboveGraphqlInt = 2_147_483_648;

    expect(
      BoardPresenceClimbRedisSchema.safeParse({
        climbUuid: 'climb-1',
        sentAt: '2026-08-30T00:00:00.000Z',
        seq: aboveGraphqlInt,
      }).success,
    ).toBe(false);
    expect(
      BoardLayersSnapshotRedisSchema.safeParse({
        boardId: 123,
        layers: [{ ...redisLayer, placementIds: [aboveGraphqlInt] }],
        observedAt: '2026-08-30T00:00:00.000Z',
        stale: false,
        seq: 2,
      }).success,
    ).toBe(false);
    expect(
      BoardPresenceEventRedisSchema.safeParse({
        __typename: 'BoardStatsUpdated',
        stats: { climbsSentCount: aboveGraphqlInt, distinctClimbersCount: 1 },
        seq: 3,
      }).success,
    ).toBe(false);
  });
});
