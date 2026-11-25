// @vitest-environment jsdom
//
// /boards/find-wall, retired into the add-a-board wizard: without a gym it lands
// on Which gym?, with one on Boards at {gym} (a gym page's old link keeps its
// entry), and on the builder with the flag off.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

const replaceMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ params: {} as Record<string, string | undefined>, wizard: true }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useAddBoardWizardEnabled: () => state.wizard,
}));

const { default: FindWall } = await import('../find-wall');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'no_board' };
  state.wizard = true;
});

describe('/boards/find-wall redirect', () => {
  it('opens Which gym? without a gym, on the type it was given, as step 2', () => {
    state.params = { ...state.params, boardType: 'moonboard' };
    render(createElement(FindWall));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add/gym',
      params: {
        entry: 'link',
        returnTo: '/(tabs)/climbs',
        source: 'no_board',
        trail: 'where',
        boardType: 'moonboard',
      },
    });
  });

  it("opens a gym's boards as step 3 of the gym path", () => {
    state.params = { ...state.params, gymUuid: 'gym-9' };
    render(createElement(FindWall));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add/gym-boards',
      params: {
        entry: 'link',
        returnTo: '/(tabs)/climbs',
        source: 'no_board',
        trail: 'where,gym',
        gymUuid: 'gym-9',
      },
    });
  });

  it("keeps a gym page's entry, which starts the count on the gym's boards", () => {
    state.params = { gymUuid: 'gym-9', entry: 'gym_page' };
    render(createElement(FindWall));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add/gym-boards',
      params: { entry: 'gym_page', gymUuid: 'gym-9' },
    });
  });

  it('opens the builder as it was with the flag off', () => {
    state.wizard = false;
    state.params = { ...state.params, gymUuid: 'gym-9' };
    render(createElement(FindWall));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });
});
