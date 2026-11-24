// @vitest-environment jsdom
//
// "Where's this board?" (#8151): a home board goes to the builder preset, a
// gym board to finding the wall that's probably already there.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };

const pushMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));

vi.mock('react-native', () => ({
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({
  ChoiceCard: ({ title, hint, onPress }: { title: string; hint: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': hint }, title),
}));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));

const { default: BoardWhere } = await import('../where');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'no_board' };
});

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

describe("Where's this board?", () => {
  it('offers My own board first, then A board at a gym', () => {
    render(createElement(BoardWhere));
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'mobile.boardWhere.own',
      'mobile.boardWhere.gym',
    ]);
  });

  it('opens the builder preset for a home board', () => {
    render(createElement(BoardWhere));
    fireEvent.click(screen.getByText('mobile.boardWhere.own'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board', kind: 'home', preset: '1' },
    });
    expect(events('Board Kind Chosen')).toEqual([{ kind: 'home', surface: 'where', preAnswered: false }]);
  });

  it('opens the gym search for a gym board', () => {
    render(createElement(BoardWhere));
    fireEvent.click(screen.getByText('mobile.boardWhere.gym'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/find-wall',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
    expect(events('Board Kind Chosen')).toEqual([{ kind: 'gym', surface: 'where', preAnswered: false }]);
  });

  it('reports leaving without an answer as abandoned at the choice step', () => {
    const { unmount } = render(createElement(BoardWhere));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([
      { kind: null, step: 'choice', openedFrom: 'no_board', secondsOpen: 0 },
    ]);
  });
});
