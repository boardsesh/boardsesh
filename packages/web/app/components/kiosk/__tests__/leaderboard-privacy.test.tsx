import React, { type ReactNode } from 'react';
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeriodLeaderboard } from '../leaderboard-rail/use-period-leaderboard';
import LeaderboardRail from '../leaderboard-rail/leaderboard-rail';

const mocks = vi.hoisted(() => ({ executeGraphQL: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: mocks.executeGraphQL }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  mocks.executeGraphQL.mockReset().mockResolvedValue({
    boardLeaderboard: { boardUuid: 'board', entries: [], totalCount: 0, hasMore: false },
  });
});
afterEach(cleanup);

describe('ranking privacy surfaces', () => {
  it('uses app consent for the public website embed by default', async () => {
    const { wrapper } = setup();
    renderHook(() => usePeriodLeaderboard(['board'], 'week', true), { wrapper });
    await waitFor(() => expect(mocks.executeGraphQL).toHaveBeenCalledOnce());
    expect(mocks.executeGraphQL.mock.calls[0][1].input).toMatchObject({ surface: 'app', period: 'week' });
  });

  it.each(['session', 'week'] as const)('loads the kiosk %s window through server consent', async (period) => {
    const { wrapper } = setup();
    render(
      <LeaderboardRail
        leaderboard={{ period, boardUuid: null }}
        boards={[
          {
            boardId: 1,
            boardUuid: 'board',
            name: 'Wall',
            slug: 'wall',
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            angle: 40,
          },
        ]}
      />,
      { wrapper },
    );
    await waitFor(() => expect(mocks.executeGraphQL).toHaveBeenCalledOnce());
    expect(mocks.executeGraphQL.mock.calls[0][1].input).toMatchObject({ surface: 'gymScreen', period });
  });

  it('keeps app and gym-screen responses in separate caches', async () => {
    const { queryClient, wrapper } = setup();
    const { rerender } = renderHook(
      ({ surface }: { surface: 'app' | 'gymScreen' }) => usePeriodLeaderboard(['board'], 'week', true, { surface }),
      { wrapper, initialProps: { surface: 'app' } },
    );
    await waitFor(() => expect(mocks.executeGraphQL).toHaveBeenCalledOnce());
    rerender({ surface: 'gymScreen' });
    await waitFor(() => expect(mocks.executeGraphQL).toHaveBeenCalledTimes(2));
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    expect(mocks.executeGraphQL.mock.calls[1][1].input.surface).toBe('gymScreen');
  });
});
