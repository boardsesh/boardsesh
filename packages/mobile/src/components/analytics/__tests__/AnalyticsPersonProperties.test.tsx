// @vitest-environment jsdom
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

  it('waits for the account-created date before writing', () => {
    // Authenticated but the profile query hasn't resolved yet.
    state.profile = null;
    state.activeBoard = { boardType: 'tension' };

    render(createElement(AnalyticsPersonProperties));

    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });
});
