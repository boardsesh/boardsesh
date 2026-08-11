import { describe, it, expect, vi } from 'vite-plus/test';

// The module pulls in the db client at import time; these pure helpers never
// touch it, so an empty stub keeps the unit test database-free. `fetchOwnerBoards`
// is exercised for real by the tick-queries integration suite.
vi.mock('../../../../db/client', () => ({ db: {} }));

const { parseBoardSetIds, toTickBoardCandidate } = await import('../render-board');

describe('parseBoardSetIds', () => {
  it('parses the CSV `user_boards.set_ids` column', () => {
    expect(parseBoardSetIds('1,20')).toEqual([1, 20]);
  });

  it('tolerates whitespace and a trailing comma', () => {
    expect(parseBoardSetIds(' 26, 27 ,28, ')).toEqual([26, 27, 28]);
  });

  it('returns an empty list for null, empty and unparseable input', () => {
    expect(parseBoardSetIds(null)).toEqual([]);
    expect(parseBoardSetIds(undefined)).toEqual([]);
    expect(parseBoardSetIds('')).toEqual([]);
    expect(parseBoardSetIds('none')).toEqual([]);
  });

  it('drops non-positive and fractional ids rather than passing them through', () => {
    expect(parseBoardSetIds('0,-3,1.5,20')).toEqual([20]);
  });
});

describe('toTickBoardCandidate', () => {
  it('builds a candidate from the joined user_boards columns', () => {
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' })).toEqual({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 20],
      isOwned: true,
    });
  });

  it('coerces bigint columns that arrive as strings', () => {
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,20' })).toMatchObject({
      layoutId: 1,
      sizeId: 10,
    });
  });

  it('returns null when the tick carries no board (the LEFT JOIN produced nulls)', () => {
    expect(toTickBoardCandidate({ boardType: null, layoutId: null, sizeId: null, setIds: null })).toBeNull();
  });

  it('returns null when any single column is missing', () => {
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: 1, sizeId: null, setIds: '1,20' })).toBeNull();
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: null, sizeId: 10, setIds: '1,20' })).toBeNull();
  });

  it('returns null for a board with no parseable sets — nothing to render with', () => {
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '' })).toBeNull();
    expect(toTickBoardCandidate({ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: 'none' })).toBeNull();
  });
});
