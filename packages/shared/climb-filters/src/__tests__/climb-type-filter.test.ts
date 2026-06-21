import { describe, it, expect } from 'vite-plus/test';
import {
  DEFAULT_CLIMB_FILTER_STATE,
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
  it('defaults to boulders-only', () => {
    expect(DEFAULT_CLIMB_FILTER_STATE.boulders).toBe(true);
    expect(DEFAULT_CLIMB_FILTER_STATE.routes).toBe(false);
  });

  it('does not count the boulders-only default as an active filter', () => {
    expect(hasActiveClimbFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
  });

  it('maps boulders-only to boulders=true with routes omitted', () => {
    const input = inputFor({ boulders: true, routes: false });
    expect(input.boulders).toBe(true);
    expect(input.routes).toBeUndefined();
  });

  it('maps routes-only to routes=true with boulders omitted', () => {
    const input = inputFor({ boulders: false, routes: true });
    expect(input.routes).toBe(true);
    expect(input.boulders).toBeUndefined();
  });

  it('omits both fields when both are selected (no frames_count constraint)', () => {
    const input = inputFor({ boulders: true, routes: true });
    expect(input.boulders).toBeUndefined();
    expect(input.routes).toBeUndefined();
  });

  it('omits both fields when neither is selected (widened to all climbs)', () => {
    const input = inputFor({ boulders: false, routes: false });
    expect(input.boulders).toBeUndefined();
    expect(input.routes).toBeUndefined();
  });

  it('treats routes-on as an active filter', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: true })).toBe(true);
  });

  it('treats boulders-off as an active filter', () => {
    expect(hasActiveClimbFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: false })).toBe(true);
  });
});
