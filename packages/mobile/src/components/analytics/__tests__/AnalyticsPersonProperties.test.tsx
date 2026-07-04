// @vitest-environment jsdom
// jsdom is required: @testing-library/react's render() mounts into document.body,
// even though this component renders null.
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ setPersonProperties: vi.fn() }));
const state = vi.hoisted(() => ({
  isAuthenticated: true,
  profile: null as Record<string, unknown> | null,
  activeBoard: null as Record<string, unknown> | null,
}));

vi.mock('../../../lib/analytics', () => ({ setPersonProperties: analytics.setPersonProperties }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: state.profile }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: state.activeBoard }) }));

import { AnalyticsPersonProperties } from '../AnalyticsPersonProperties';

beforeEach(() => {
  analytics.setPersonProperties.mockClear();
  state.isAuthenticated = true;
  state.profile = null;
  state.activeBoard = null;
});

describe('AnalyticsPersonProperties', () => {
  it('writes cohort person properties once the profile resolves', () => {
    state.profile = {
      id: 'user-1',
      createdAt: '2024-01-02T03:04:05.000Z',
      isTester: false,
      favoriteCount: 7,
    };
    state.activeBoard = { boardType: 'kilter' };

    render(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).toHaveBeenCalledWith(
      { role: 'user', favorite_count: 7, home_board: 'kilter' },
      { account_created_at: '2024-01-02T03:04:05.000Z' },
    );
  });

  it('does not write while signed out', () => {
    state.isAuthenticated = false;
    state.profile = null;

    render(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });

  it('does not write until the profile query resolves', () => {
    // Authenticated but the profile query hasn't resolved yet.
    state.profile = null;
    state.activeBoard = { boardType: 'tension' };

    render(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });

  it('does not write when the profile resolved without a created-at date', () => {
    // Guards the createdAt branch specifically: an identified user (id present)
    // whose account age hasn't come back yet must not write a setOnce with
    // undefined account_created_at.
    state.profile = { id: 'user-1', createdAt: null, isTester: false, favoriteCount: 2 };
    state.activeBoard = { boardType: 'kilter' };

    render(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });

  it('stops writing after the user signs out', () => {
    state.profile = { id: 'user-1', createdAt: '2024-01-02T03:04:05.000Z', isTester: false, favoriteCount: 1 };
    state.activeBoard = { boardType: 'kilter' };

    const { rerender } = render(createElement(AnalyticsPersonProperties));
    expect(analytics.setPersonProperties).toHaveBeenCalledTimes(1);

    // Sign-out clears auth + the gated profile query — the guard must hold.
    state.isAuthenticated = false;
    state.profile = null;
    rerender(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).toHaveBeenCalledTimes(1);
  });

  it('re-writes when a live trait changes after the first resolve', () => {
    state.profile = { id: 'user-1', createdAt: '2024-01-02T03:04:05.000Z', isTester: false, favoriteCount: 1 };
    state.activeBoard = { boardType: 'kilter' };

    const { rerender } = render(createElement(AnalyticsPersonProperties));
    expect(analytics.setPersonProperties).toHaveBeenCalledTimes(1);

    // User earns the tester role and switches board — the effect must re-fire with
    // the new values (React only re-runs it because the deps actually changed).
    state.profile = { id: 'user-1', createdAt: '2024-01-02T03:04:05.000Z', isTester: true, favoriteCount: 4 };
    state.activeBoard = { boardType: 'tension' };
    rerender(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).toHaveBeenCalledTimes(2);
    expect(analytics.setPersonProperties).toHaveBeenLastCalledWith(
      { role: 'tester', favorite_count: 4, home_board: 'tension' },
      { account_created_at: '2024-01-02T03:04:05.000Z' },
    );
  });
});
