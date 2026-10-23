// @vitest-environment jsdom
//
// A playlist's / smart list's setter picker: which list it reads from its route
// params, what the rows show, and the two ways its picks go back (back chevron
// or "Show climbs"), each exactly once and addressed to the sheet that opened it.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetterPickerListProps } from '../../../../src/components/filter-sheet/SetterPickerList';
import { subscribeToSetterFilterSelection } from '../../../../src/lib/setter-filter-handoff';

const params = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
const navigation = vi.hoisted(() => ({
  goBack: vi.fn(),
  beforeRemove: null as null | (() => void),
}));
const picker = vi.hoisted(() => ({ props: null as SetterPickerListProps | null }));
const header = vi.hoisted(() => ({ trailing: null as null | { label: string; onPress: () => void } }));
const settersHook = vi.hoisted(() => ({
  calls: [] as Array<{ source: unknown; search: string }>,
  result: {
    setters: [
      { username: 'alex', climbCount: 12 },
      { username: 'sam', climbCount: 3 },
    ] as Array<{ username: string; climbCount: number }> | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useNavigation: () => ({
    goBack: navigation.goBack,
    addListener: (event: string, listener: () => void) => {
      if (event === 'beforeRemove') navigation.beforeRemove = listener;
      return () => {
        navigation.beforeRemove = null;
      };
    },
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) =>
      `${namespace ?? ''}:${options == null ? key : `${key}:${Object.values(options).join(',')}`}`,
  }),
}));
vi.mock('@boardsesh/playlists-react', () => ({
  usePlaylistSetters: (input: { source: unknown; search: string }) => {
    settersHook.calls.push(input);
    return settersHook.result;
  },
}));
vi.mock('../../../../src/components/filter-sheet/SetterPickerList', () => ({
  SetterPickerList: (props: SetterPickerListProps) => {
    picker.props = props;
    return createElement('div', { 'data-testid': 'picker' });
  },
}));
vi.mock('../../../../src/hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing }: { trailing: { label: string; onPress: () => void } }) => {
    header.trailing = trailing;
  },
}));

import PlaylistSettersScreen from '../playlist-setters';

type Received = { setters: string[]; options: { apply?: boolean } };
const received: Received[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  params.current = {
    playlistId: 'playlist-1',
    handoffId: 'filter-picker-7',
    setters: JSON.stringify(['sam']),
  };
  navigation.goBack.mockReset();
  navigation.beforeRemove = null;
  picker.props = null;
  header.trailing = null;
  settersHook.calls = [];
  settersHook.result.isError = false;
  settersHook.result.refetch.mockReset();
  received.length = 0;
  unsubscribe = subscribeToSetterFilterSelection('filter-picker-7', (setters, options) =>
    received.push({ setters, options }),
  );
});

afterEach(() => unsubscribe());

describe('PlaylistSettersScreen', () => {
  it("lists the list's setters with their climb counts, and the sheet's picks checked", () => {
    render(createElement(PlaylistSettersScreen));
    expect(picker.props?.setters).toEqual([
      { setterUsername: 'alex', count: 12 },
      { setterUsername: 'sam', count: 3 },
    ]);
    expect(picker.props?.selected).toEqual(['sam']);
    expect(picker.props?.formatCount(12)).toBe('climbs:mobile.search.climbsCount:12');
  });

  it('passes the typed search to the setters query', () => {
    render(createElement(PlaylistSettersScreen));
    expect(settersHook.calls.at(-1)?.search).toBe('');
    act(() => picker.props?.onSearchChange('al'));
    expect(settersHook.calls.at(-1)?.search).toBe('al');
  });

  it('reads a playlist source from a playlist id', () => {
    render(createElement(PlaylistSettersScreen));
    expect(settersHook.calls.at(-1)?.source).toEqual({ kind: 'playlist', playlistId: 'playlist-1' });
  });

  it('reads a smart list source from a smart type and owner', () => {
    params.current = { smartType: 'LIKED_CLIMBS', userId: 'climber-1', handoffId: 'filter-picker-7' };
    render(createElement(PlaylistSettersScreen));
    expect(settersHook.calls.at(-1)?.source).toEqual({
      kind: 'smart',
      smartType: 'LIKED_CLIMBS',
      userId: 'climber-1',
    });
  });

  it.each([
    ['no list at all', {}],
    ['a smart type without an owner', { smartType: 'LIKED_CLIMBS' }],
    ['an owner without a smart type', { userId: 'climber-1' }],
    ['an unknown smart type', { smartType: 'nonsense', userId: 'climber-1' }],
  ])('falls back to the empty stand-in list for %s', (_label, sourceParams) => {
    params.current = { ...sourceParams, handoffId: 'filter-picker-7' };
    render(createElement(PlaylistSettersScreen));
    expect(settersHook.calls.at(-1)?.source).toEqual({ kind: 'playlist', playlistId: '' });
  });

  it('drops an unreadable setters param rather than crashing', () => {
    params.current = { playlistId: 'playlist-1', setters: 'not json' };
    render(createElement(PlaylistSettersScreen));
    expect(picker.props?.selected).toEqual([]);
  });

  it('hands the picks back once, on the way out, without apply', () => {
    render(createElement(PlaylistSettersScreen));
    act(() => picker.props?.onToggle('alex'));
    expect(received).toEqual([]);
    act(() => navigation.beforeRemove?.());
    expect(received).toEqual([{ setters: ['sam', 'alex'], options: {} }]);
    expect(received[0]?.options).not.toHaveProperty('apply');
  });

  it('"Show climbs" hands the picks back with apply once and goes back, and the removal does not emit again', () => {
    render(createElement(PlaylistSettersScreen));
    expect(header.trailing?.label).toBe('playlists:detail.setterPicker.showClimbs');
    act(() => header.trailing?.onPress());
    act(() => header.trailing?.onPress());
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    act(() => navigation.beforeRemove?.());
    expect(received).toEqual([{ setters: ['sam'], options: { apply: true } }]);
  });

  it('hands the picks to nobody when opened without a handoff id', () => {
    params.current = { playlistId: 'playlist-1', setters: JSON.stringify(['sam']) };
    render(createElement(PlaylistSettersScreen));
    act(() => header.trailing?.onPress());
    act(() => navigation.beforeRemove?.());
    expect(received).toEqual([]);
  });

  it('offers a retry when the setters fail to load', () => {
    settersHook.result.isError = true;
    render(createElement(PlaylistSettersScreen));
    expect(picker.props?.error?.message).toBe('playlists:detail.setterPicker.error');
    picker.props?.error?.onRetry();
    expect(settersHook.result.refetch).toHaveBeenCalledTimes(1);
  });
});
