import { describe, it, expect } from 'vite-plus/test';
import type { AscentFeedItem } from '@boardsesh/graphql/operations/ticks';
import { ascentFeedItemToClimb } from '../ascent-to-climb';

function makeItem(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-uuid',
    climbName: 'Test Climb',
    setterUsername: 'setter',
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: 4,
    difficulty: 20,
    difficultyName: '7a/V6',
    consensusDifficulty: 21,
    consensusDifficultyName: '7a+/V7',
    qualityAverage: 3.5,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: '2026-04-01T00:00:00Z',
    frames: 'p1r14',
    ...overrides,
  };
}

describe('ascentFeedItemToClimb', () => {
  it('maps basic fields from the feed item', () => {
    const result = ascentFeedItemToClimb(makeItem());
    expect(result.uuid).toBe('climb-uuid');
    expect(result.name).toBe('Test Climb');
    expect(result.setter_username).toBe('setter');
    expect(result.frames).toBe('p1r14');
    expect(result.angle).toBe(40);
    expect(result.mirrored).toBe(false);
    expect(result.layoutId).toBe(1);
    expect(result.boardType).toBe('kilter');
  });

  it('prefers consensusDifficultyName over difficultyName for difficulty', () => {
    const result = ascentFeedItemToClimb(makeItem({ consensusDifficultyName: '7a+/V7', difficultyName: '7a/V6' }));
    expect(result.difficulty).toBe('7a+/V7');
  });

  it('falls back to difficultyName when consensusDifficultyName is null', () => {
    const result = ascentFeedItemToClimb(makeItem({ consensusDifficultyName: null, difficultyName: '7a/V6' }));
    expect(result.difficulty).toBe('7a/V6');
  });

  it('uses empty string when both difficulty names are null', () => {
    const result = ascentFeedItemToClimb(makeItem({ consensusDifficultyName: null, difficultyName: null }));
    expect(result.difficulty).toBe('');
  });

  it('stringifies qualityAverage when present', () => {
    const result = ascentFeedItemToClimb(makeItem({ qualityAverage: 3.5 }));
    expect(result.quality_average).toBe('3.5');
  });

  it('defaults quality_average to "0" when qualityAverage is null', () => {
    const result = ascentFeedItemToClimb(makeItem({ qualityAverage: null }));
    expect(result.quality_average).toBe('0');
  });

  it('sets benchmark_difficulty to consensusDifficultyName when isBenchmark is true', () => {
    const result = ascentFeedItemToClimb(makeItem({ isBenchmark: true, consensusDifficultyName: '7a+/V7' }));
    expect(result.benchmark_difficulty).toBe('7a+/V7');
  });

  it('sets benchmark_difficulty to null when isBenchmark is false', () => {
    const result = ascentFeedItemToClimb(makeItem({ isBenchmark: false }));
    expect(result.benchmark_difficulty).toBeNull();
  });

  it('sets benchmark_difficulty to null when isBenchmark is true but consensusDifficultyName is null', () => {
    const result = ascentFeedItemToClimb(makeItem({ isBenchmark: true, consensusDifficultyName: null }));
    expect(result.benchmark_difficulty).toBeNull();
  });

  it('defaults setter_username to empty string when null', () => {
    const result = ascentFeedItemToClimb(makeItem({ setterUsername: null }));
    expect(result.setter_username).toBe('');
  });

  it('defaults frames to empty string when null', () => {
    const result = ascentFeedItemToClimb(makeItem({ frames: null }));
    expect(result.frames).toBe('');
  });

  it('sets constant fields to expected defaults', () => {
    const result = ascentFeedItemToClimb(makeItem());
    expect(result.stars).toBe(0);
    expect(result.difficulty_error).toBe('0');
    expect(result.ascensionist_count).toBe(0);
  });
});
