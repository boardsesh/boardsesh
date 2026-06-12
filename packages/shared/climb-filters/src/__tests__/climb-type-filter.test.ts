import { describe, it, expect } from 'vite-plus/test';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  climbTypeOf,
  climbTypePatch,
  hasActiveClimbFilters,
  toClimbSearchInput,
  type ClimbFilterState,
} from '../filter-state';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const pagination = { page: 0, pageSize: 20 };

function inputFor(overrides: Partial<ClimbFilterState>) {
  return toClimbSearchInput({ ...DEFAULT_CLIMB_FILTER_STATE, ...overrides }, board, pagination);
}

describe('climb-type (boulders/routes) filter', () => {
  it('defaults to all climbs', () => {
    expect(DEFAULT_CLIMB_FILTER_STATE.boulders).toBeUndefined();
    expect(DEFAULT_CLIMB_FILTER_STATE.routes).toBeUndefined();
  });

  it('does not count the all-climbs default as an active filter', () => {
    expect(hasActiveClimbFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
  });

  it('maps boulders-only to explicit boulders=true/routes=false', () => {
    const input = inputFor({ boulders: true, routes: false });
    expect(input.boulders).toBe(true);
    expect(input.routes).toBe(false);
  });

  it('maps routes-only to explicit boulders=false/routes=true', () => {
    const input = inputFor({ boulders: false, routes: true });
    expect(input.routes).toBe(true);
    expect(input.boulders).toBe(false);
  });

  it('preserves explicit both-selected values', () => {
    const input = inputFor({ boulders: true, routes: true });
    expect(input.boulders).toBe(true);
    expect(input.routes).toBe(true);
  });

  it('preserves explicit neither-selected values', () => {
    const input = inputFor({ boulders: false, routes: false });
    expect(input.boulders).toBe(false);
    expect(input.routes).toBe(false);
  });

  it('treats explicit routes-only as an active filter', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: true })).toBe(true);
  });

  it('treats explicit boulders-only as an active filter', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: true, routes: false })).toBe(true);
  });

  it('maps UI climb type patches through a single 3-way helper', () => {
    expect(climbTypeOf(DEFAULT_CLIMB_FILTER_STATE)).toBe('all');
    expect(climbTypePatch('all')).toEqual({ boulders: undefined, routes: undefined });
    expect(climbTypePatch('boulders')).toEqual({ boulders: true, routes: false });
    expect(climbTypePatch('routes')).toEqual({ boulders: false, routes: true });
  });
});
