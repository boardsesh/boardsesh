import { describe, it, expect } from 'vitest';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import { buildClimbStub, formatByline, rankBySizeCompatibility } from '../similar-climbs-utils';

function makeSimilar(overrides: Partial<SimilarClimb> = {}): SimilarClimb {
  return {
    uuid: 'u1',
    name: 'Test Climb',
    setterUsername: 'setter',
    angle: 40,
    layoutId: 1,
    frames: 'p1145r12',
    difficultyName: '6c/V5',
    qualityAverage: 2.5,
    ascensionistCount: 5,
    compatibleSizeIds: [1, 2],
    similarity: 0.9,
    sharedHoldCount: 9,
    candidateHoldCount: 10,
    targetHoldCount: 10,
    ...overrides,
  };
}

// Fake i18n mirroring the climbs `sends` plural key (display via formattedCount).
const t = (key: string, options: { count: number; formattedCount: string }) =>
  key === 'sends' ? `${options.formattedCount} send${options.count === 1 ? '' : 's'}` : key;

describe('formatByline', () => {
  it('joins setter, quality, and sends', () => {
    expect(formatByline(makeSimilar(), t)).toBe('setter · 2.5★ · 5 sends');
  });

  it('uses singular "send" for a single ascent', () => {
    expect(formatByline(makeSimilar({ ascensionistCount: 1 }), t)).toBe('setter · 2.5★ · 1 send');
  });

  it('skips null setter, zero quality, and zero ascensionists', () => {
    expect(formatByline(makeSimilar({ setterUsername: null, qualityAverage: 0, ascensionistCount: 0 }), t)).toBe('');
  });

  it('keeps only the setter when stats are null', () => {
    expect(formatByline(makeSimilar({ setterUsername: 'bob', qualityAverage: null, ascensionistCount: null }), t)).toBe(
      'bob',
    );
  });
});

describe('buildClimbStub', () => {
  it('maps camelCase similar fields to the snake_case Climb shape', () => {
    const stub = buildClimbStub(makeSimilar(), 'kilter');
    expect(stub).toMatchObject({
      uuid: 'u1',
      boardType: 'kilter',
      name: 'Test Climb',
      setter_username: 'setter',
      difficulty: '6c/V5',
      quality_average: '2.50',
      ascensionist_count: 5,
      stars: 0,
      benchmark_difficulty: null,
    });
  });

  it('falls back to safe placeholders when fields are null', () => {
    const stub = buildClimbStub(
      makeSimilar({
        name: null,
        setterUsername: null,
        frames: null,
        angle: null,
        difficultyName: null,
        qualityAverage: null,
        ascensionistCount: null,
      }),
      'tension',
    );
    expect(stub).toMatchObject({
      name: '',
      setter_username: '',
      frames: '',
      angle: 0,
      difficulty: '',
      quality_average: '',
      ascensionist_count: 0,
    });
  });
});

describe('rankBySizeCompatibility', () => {
  it('ranks compatible climbs first while preserving order within each group', () => {
    const a = makeSimilar({ uuid: 'a', compatibleSizeIds: [1] });
    const b = makeSimilar({ uuid: 'b', compatibleSizeIds: [2] });
    const c = makeSimilar({ uuid: 'c', compatibleSizeIds: [1, 3] });

    const ranked = rankBySizeCompatibility([a, b, c], 1);

    expect(ranked.map((entry) => entry.climb.uuid)).toEqual(['a', 'c', 'b']);
    expect(ranked.map((entry) => entry.compatible)).toEqual([true, true, false]);
  });

  it('returns an empty array for no climbs', () => {
    expect(rankBySizeCompatibility([], 1)).toEqual([]);
  });
});
