import { describe, expect, it } from 'vitest';
import {
  climbTypeOf,
  climbTypePatch,
  hasActiveClimbFilters,
  toClimbSearchInput,
  DEFAULT_CLIMB_FILTER_STATE,
  type BoardSearchConfig,
} from '../filter-state';

const board: BoardSearchConfig = { boardName: 'kilter', layoutId: 1, sizeId: 7, setIds: '1,20', angle: 40 };
const page = { page: 0, pageSize: 30 };

describe('climbTypeOf / climbTypePatch', () => {
  it('maps the default (both undefined) to "all"', () => {
    expect(climbTypeOf({})).toBe('all');
    expect(climbTypePatch('all')).toEqual({ boulders: undefined, routes: undefined });
  });

  it('round-trips boulders and routes', () => {
    expect(climbTypeOf(climbTypePatch('boulders'))).toBe('boulders');
    expect(climbTypeOf(climbTypePatch('routes'))).toBe('routes');
    expect(climbTypePatch('boulders')).toEqual({ boulders: true, routes: false });
    expect(climbTypePatch('routes')).toEqual({ boulders: false, routes: true });
  });

  it('treats both-true as "all"', () => {
    expect(climbTypeOf({ boulders: true, routes: true })).toBe('all');
  });
});

describe('boulders/routes in filter state', () => {
  it('hasActiveClimbFilters is true for any explicit climb type (including routes-only false boulders)', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: true, routes: false })).toBe(true);
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: true })).toBe(true);
    expect(hasActiveClimbFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
  });

  it('toClimbSearchInput passes explicit false (routes-only) through', () => {
    const input = toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: true }, board, page);
    expect(input.boulders).toBe(false);
    expect(input.routes).toBe(true);
  });

  it('toClimbSearchInput omits climb type when unset (all)', () => {
    const input = toClimbSearchInput(DEFAULT_CLIMB_FILTER_STATE, board, page);
    expect(input.boulders).toBeUndefined();
    expect(input.routes).toBeUndefined();
  });
});
