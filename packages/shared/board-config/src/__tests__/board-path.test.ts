import { describe, it, expect } from 'vitest';
import { buildBoardPath, parseBoardPath, parseNamedBoardPath } from '../board-path';

describe('buildBoardPath', () => {
  it('builds a path with angle', () => {
    expect(buildBoardPath('kilter', 8, 17, '26,27', 40)).toBe('kilter/8/17/26,27/40');
  });

  it('builds a path without angle', () => {
    expect(buildBoardPath('kilter', 8, 17, '26,27')).toBe('kilter/8/17/26,27');
  });

  it('accepts string ids', () => {
    expect(buildBoardPath('tension', '1', '10', '1,2', '45')).toBe('tension/1/10/1,2/45');
  });

  it('treats angle 0 as present', () => {
    expect(buildBoardPath('kilter', 8, 17, '26,27', 0)).toBe('kilter/8/17/26,27/0');
  });

  it('omits empty-string angle instead of producing a trailing slash', () => {
    expect(buildBoardPath('kilter', 8, 17, '26,27', '')).toBe('kilter/8/17/26,27');
  });
});

describe('parseBoardPath', () => {
  it('round-trips with buildBoardPath', () => {
    expect(parseBoardPath(buildBoardPath('kilter', 8, 17, '26,27', 40))).toEqual({
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      angle: 40,
    });
  });

  it('parses the bare form and keeps comma-joined setIds intact', () => {
    expect(parseBoardPath('kilter/8/17/26,27/40')).toEqual({
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      angle: 40,
    });
  });

  it('parses a leading-slash full pathname with trailing segments', () => {
    expect(parseBoardPath('/kilter/1/10/1/45/list')).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      angle: 45,
    });
  });

  it('drops a leading locale segment', () => {
    expect(parseBoardPath('/es/tension/1/10/1,2/55/list')).toEqual({
      boardName: 'tension',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 55,
    });
  });

  it('treats angle 0 as a real angle', () => {
    expect(parseBoardPath('kilter/8/17/26,27/0')?.angle).toBe(0);
  });

  it('returns angle null when absent', () => {
    expect(parseBoardPath('kilter/8/17/26,27')).toEqual({
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      angle: null,
    });
  });

  it('returns null for non-board paths', () => {
    expect(parseBoardPath('')).toBeNull();
    expect(parseBoardPath('/b/my-board-slug/40')).toBeNull();
    expect(parseBoardPath('kilter/notanumber/17/26,27/40')).toBeNull();
  });
});

describe('parseNamedBoardPath', () => {
  it('parses a bare named-board path with no angle', () => {
    expect(parseNamedBoardPath('/b/boiler-room-moonboard-c937dad5')).toEqual({
      slug: 'boiler-room-moonboard-c937dad5',
      angle: null,
    });
  });

  it('parses a named-board path with an angle and trailing segments', () => {
    expect(parseNamedBoardPath('/b/boiler-room-moonboard-c937dad5/40/list')).toEqual({
      slug: 'boiler-room-moonboard-c937dad5',
      angle: 40,
    });
  });

  it('tolerates a missing leading slash', () => {
    expect(parseNamedBoardPath('b/my-board/25')).toEqual({ slug: 'my-board', angle: 25 });
  });

  it('drops a leading locale segment', () => {
    expect(parseNamedBoardPath('/es/b/my-board/40/list')).toEqual({ slug: 'my-board', angle: 40 });
  });

  it('returns angle null when the third segment is not numeric', () => {
    expect(parseNamedBoardPath('/b/my-board/list')).toEqual({ slug: 'my-board', angle: null });
  });

  it('returns null for tuple board paths and other shapes', () => {
    expect(parseNamedBoardPath('kilter/8/17/26,27/40')).toBeNull();
    expect(parseNamedBoardPath('/b')).toBeNull();
    expect(parseNamedBoardPath('')).toBeNull();
  });
});
