import { describe, it, expect } from 'vitest';
import { tickToClimb, type TickLike } from '../tick-to-climb';

function makeTick(overrides: Partial<TickLike> = {}): TickLike {
  return {
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    frames: 'p1145r12',
    angle: 40,
    difficultyName: 'V4',
    quality: 3,
    setterUsername: 'setter',
    isBenchmark: false,
    isMirror: false,
    isNoMatch: false,
    boardType: 'kilter',
    layoutId: 1,
    ...overrides,
  };
}

describe('tickToClimb', () => {
  it('returns null when the tick has no frames', () => {
    expect(tickToClimb(makeTick({ frames: null }))).toBeNull();
    expect(tickToClimb(makeTick({ frames: '' }))).toBeNull();
  });

  it('maps tick fields onto a renderable Climb', () => {
    const climb = tickToClimb(
      makeTick({ climbUuid: 'c-9', frames: 'p10r15', angle: 50, difficultyName: 'V6', quality: 4 }),
    );
    expect(climb).toMatchObject({
      uuid: 'c-9',
      name: 'Test Climb',
      frames: 'p10r15',
      angle: 50,
      difficulty: 'V6',
      quality_average: '4',
      stars: 4,
      setter_username: 'setter',
      mirrored: false,
      is_no_match: false,
      boardType: 'kilter',
      layoutId: 1,
    });
  });

  it('falls back to the uuid for a missing name and 0 quality', () => {
    const climb = tickToClimb(makeTick({ climbName: null, quality: null }));
    expect(climb?.name).toBe('climb-1');
    expect(climb?.quality_average).toBe('0');
    expect(climb?.stars).toBe(0);
  });

  it('marks benchmark difficulty only when the tick is a benchmark', () => {
    expect(tickToClimb(makeTick({ isBenchmark: true, difficultyName: 'V5' }))?.benchmark_difficulty).toBe('V5');
    expect(tickToClimb(makeTick({ isBenchmark: false, difficultyName: 'V5' }))?.benchmark_difficulty).toBeNull();
  });
});
