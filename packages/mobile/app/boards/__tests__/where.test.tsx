// @vitest-environment jsdom
//
// /boards/where, retired into the add-a-board wizard: an old link lands on the
// wizard's step 1 with the flag on, and on the builder with it off. It draws
// nothing and reports nothing itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

const replaceMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ params: {} as Record<string, string | undefined>, wizard: true }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useAddBoardWizardEnabled: () => state.wizard,
}));

const { default: BoardWhere } = await import('../where');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'no_board' };
  state.wizard = true;
});

describe('/boards/where redirect', () => {
  it("opens the wizard's Where's the board? as an old link, keeping return and source", () => {
    const { container } = render(createElement(BoardWhere));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board', entry: 'link' },
    });
    expect(container.innerHTML).toBe('');
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('opens the builder as it was with the flag off', () => {
    state.wizard = false;
    render(createElement(BoardWhere));
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });
});
