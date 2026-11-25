// @vitest-environment jsdom
//
// The find step's route (#8151): the gym step (map and search) without a gym,
// the gym's walls with one, and the builder as it was when the gym-first flag
// is off.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';

const replaceMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  gymFirst: true,
  signedIn: true,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('@boardsesh/board-config', () => ({
  toBoardName: (value: string | undefined) => (value === 'moonboard' ? value : null),
  SUPPORTED_BOARDS: ['kilter', 'moonboard'],
}));
vi.mock('../../../src/components/board-discovery/gym-step/GymStep', () => ({
  GymStep: ({
    initialBoardType,
    onPickGym,
    onAddGym,
  }: {
    initialBoardType: string | null;
    onPickGym: (gym: { uuid: string }, boardType: string | null) => void;
    onAddGym: (boardType: string | null) => void;
  }) =>
    createElement('div', { 'data-testid': 'gym-search' }, [
      createElement('span', { key: 'type', 'data-testid': 'initial-type' }, String(initialBoardType)),
      createElement('button', {
        key: 'pick',
        type: 'button',
        'data-testid': 'pick',
        onClick: () => onPickGym({ uuid: 'gym-9' }, 'kilter'),
      }),
      createElement('button', { key: 'add', type: 'button', 'data-testid': 'add', onClick: () => onAddGym(null) }),
    ]),
}));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
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
  state.signedIn = true;
});

describe('find-wall route', () => {
  it('opens the gym search without a gym, on the type it was given', () => {
    state.params = { ...state.params, boardType: 'moonboard' };
    render(createElement(FindWall));
    expect(screen.getByTestId('initial-type').textContent).toBe('moonboard');
  });

  it("opens a picked gym's walls on this route, keeping the type and where to return", () => {
    render(createElement(FindWall));
    fireEvent.click(screen.getByTestId('pick'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/find-wall',
      params: { gymUuid: 'gym-9', boardType: 'kilter', returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });

  it('opens the builder on its location for Add my gym, after signing in', () => {
    const view = render(createElement(FindWall));
    fireEvent.click(screen.getByTestId('add'));
    expect(pushMock).toHaveBeenLastCalledWith({
      pathname: '/boards/create',
      params: { kind: 'gym', focusLocation: '1', returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
    view.unmount();
    state.signedIn = false;
    render(createElement(FindWall));
    fireEvent.click(screen.getByTestId('add'));
    expect(pushMock).toHaveBeenLastCalledWith('/auth/login');
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
