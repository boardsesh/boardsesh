// @vitest-environment jsdom
//
// The find step's route (#8151): the gym search without a gym, the gym's walls
// with one, and the builder as it was when the gym-first flag is off.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';

const replaceMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ params: {} as Record<string, string | undefined>, gymFirst: true }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('@boardsesh/board-config', () => ({
  toBoardName: (value: string | undefined) => (value === 'moonboard' ? value : null),
  SUPPORTED_BOARDS: ['kilter', 'moonboard'],
}));
vi.mock('../../../src/components/board-discovery/FindWallGymSearch', () => ({
  FindWallGymSearch: ({ initialBoardType }: { initialBoardType: string | null }) =>
    createElement('div', { 'data-testid': 'gym-search' }, String(initialBoardType)),
}));
vi.mock('../../../src/components/board-discovery/GymWallList', () => ({
  GymWallList: ({ gymUuid, entry }: { gymUuid: string; entry: string }) =>
    createElement('div', { 'data-testid': 'gym-walls' }, `${gymUuid} ${entry}`),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useCreateBoardGymFirstEnabled: () => state.gymFirst,
}));

const { default: FindWall } = await import('../find-wall');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'no_board' };
  state.gymFirst = true;
});

describe('find-wall route', () => {
  it('opens the gym search without a gym, on the type it was given', () => {
    state.params = { ...state.params, boardType: 'moonboard' };
    render(createElement(FindWall));
    expect(screen.getByTestId('gym-search').textContent).toBe('moonboard');
  });

  it("opens a gym's walls with one, saying when a gym page sent it", () => {
    state.params = { ...state.params, gymUuid: 'gym-1', entry: 'gym_page' };
    render(createElement(FindWall));
    expect(screen.getByTestId('gym-walls').textContent).toBe('gym-1 gym_page');
  });

  it('hands straight on to the builder with the flag off, and reports nothing', () => {
    state.gymFirst = false;
    state.params = { ...state.params, gymUuid: 'gym-1' };
    const { unmount } = render(createElement(FindWall));
    expect(replaceMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
    expect(screen.queryByTestId('gym-walls')).toBeNull();
    unmount();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reports leaving the find step without a board', () => {
    const { unmount } = render(createElement(FindWall));
    unmount();
    expect(trackMock).toHaveBeenCalledWith(
      'Board Builder Abandoned',
      expect.objectContaining({ kind: 'gym', step: 'find', openedFrom: 'no_board' }),
    );
  });
});
