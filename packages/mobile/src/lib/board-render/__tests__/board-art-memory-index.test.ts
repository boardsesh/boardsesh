import { beforeEach, describe, expect, it } from 'vitest';
import { forgetBoardArtInMemory, isBoardArtInMemory, noteBoardArtInMemory } from '../board-art-memory-index';
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
