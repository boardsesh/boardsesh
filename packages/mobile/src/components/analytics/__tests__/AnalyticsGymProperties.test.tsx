// @vitest-environment jsdom
// jsdom is required: @testing-library/react's render() mounts into document.body,
// even though this component renders null.
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsGym = vi.hoisted(() => ({ registerActiveGym: vi.fn() }));
const state = vi.hoisted(() => ({ activeBoard: null as Record<string, unknown> | null }));

vi.mock('../../../lib/analytics-gym', () => ({ registerActiveGym: analyticsGym.registerActiveGym }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: state.activeBoard }) }));

import { AnalyticsGymProperties } from '../AnalyticsGymProperties';

beforeEach(() => {
  analyticsGym.registerActiveGym.mockClear();
  state.activeBoard = null;
});

describe('AnalyticsGymProperties', () => {
  it('registers the active board gym', () => {
    state.activeBoard = { gymUuid: 'gym-1', gymName: 'Bloclab' };

    render(createElement(AnalyticsGymProperties));

    expect(analyticsGym.registerActiveGym).toHaveBeenCalledWith({ uuid: 'gym-1', name: 'Bloclab' });
  });

  it('clears the gym for a home wall with no gym linked', () => {
    state.activeBoard = { gymUuid: null, gymName: null };

    render(createElement(AnalyticsGymProperties));

    expect(analyticsGym.registerActiveGym).toHaveBeenCalledWith(null);
  });

  it('clears rather than half-stamping a gym whose name has not resolved', () => {
    state.activeBoard = { gymUuid: 'gym-1', gymName: null };

    render(createElement(AnalyticsGymProperties));

    expect(analyticsGym.registerActiveGym).toHaveBeenCalledWith(null);
  });

  // The board a climber switches to is the one their next events belong to.
  it('re-registers when the active board moves to another gym', () => {
    state.activeBoard = { gymUuid: 'gym-1', gymName: 'Bloclab' };
    const { rerender } = render(createElement(AnalyticsGymProperties));

    state.activeBoard = { gymUuid: 'gym-2', gymName: 'Galpon Boulder' };
    rerender(createElement(AnalyticsGymProperties));

    expect(analyticsGym.registerActiveGym).toHaveBeenLastCalledWith({ uuid: 'gym-2', name: 'Galpon Boulder' });
  });

  // Each register() is a persisted write and the query hands back a fresh object
  // identity on every refetch, so a re-render that changed nothing must not write.
  it('does not re-register when the board object identity changes but the gym does not', () => {
    state.activeBoard = { gymUuid: 'gym-1', gymName: 'Bloclab' };
    const { rerender } = render(createElement(AnalyticsGymProperties));
    analyticsGym.registerActiveGym.mockClear();

    state.activeBoard = { gymUuid: 'gym-1', gymName: 'Bloclab' };
    rerender(createElement(AnalyticsGymProperties));

    expect(analyticsGym.registerActiveGym).not.toHaveBeenCalled();
  });
});
