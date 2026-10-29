import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetBoardArtInMemory,
  isBoardArtInMemory,
  msSinceImageMemorySweep,
  noteBoardArtInMemory,
} from '../board-art-memory-index';
describe('decoded artwork generation', () => {
  beforeEach(forgetBoardArtInMemory);
  it('distinguishes same-URI generations while preserving existing URI-only callers', () => {
    noteBoardArtInMemory('file:///same.png', '1');
    expect(isBoardArtInMemory('file:///same.png')).toBe(true);
    expect(isBoardArtInMemory('file:///same.png', '1')).toBe(true);
    expect(isBoardArtInMemory('file:///same.png', '2')).toBe(false);
    noteBoardArtInMemory('file:///same.png', '2');
    expect(isBoardArtInMemory('file:///same.png', '1')).toBe(false);
    expect(isBoardArtInMemory('file:///same.png', '2')).toBe(true);
  });
  it('does not treat a URI-only load as proof of a generation', () => {
    noteBoardArtInMemory('file:///same.png');
    expect(isBoardArtInMemory('file:///same.png', '1')).toBe(false);
  });
  it('forgets generation readiness with decoded artwork', () => {
    noteBoardArtInMemory('file:///same.png', '1');
    forgetBoardArtInMemory();
    expect(isBoardArtInMemory('file:///same.png', '1')).toBe(false);
  });
});

describe('msSinceImageMemorySweep', () => {
  afterEach(() => vi.restoreAllMocks());

  // A device clock set back must not make an old sweep read as one that just ran.
  it('counts on the monotonic clock, not the wall clock', () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    forgetBoardArtInMemory();
    monotonic.mockReturnValue(12_500);
    wallClock.mockReturnValue(1_000_000);
    expect(msSinceImageMemorySweep()).toBe(2_500);
  });
});
