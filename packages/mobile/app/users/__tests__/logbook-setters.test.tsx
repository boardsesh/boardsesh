// @vitest-environment jsdom
//
// The Logbook setter picker: what it reads from the Logbook that pushed it, the
// 20-setter cap, and the two ways its picks go back (back chevron or "Show
// climbs"), each exactly once and addressed to the right Logbook.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetterPickerListProps } from '../../../src/components/filter-sheet/SetterPickerList';
import { subscribeToLogbookSetterSelection, type LogbookSetterPicks } from '../../../src/lib/logbook-setter-handoff';

const params = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
const navigation = vi.hoisted(() => ({
  setOptions: vi.fn(),
  goBack: vi.fn(),
  removed: null as null | (() => void),
}));
const picker = vi.hoisted(() => ({ props: null as SetterPickerListProps | null }));
const header = vi.hoisted(() => ({ trailing: null as null | { label: string; onPress: () => void } }));
const settersHook = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string | undefined; scope: unknown; search: string }>,
  result: {
    setters: [
      { setterUsername: 'alex', tickCount: 12 },
      { setterUsername: 'sam', tickCount: 3 },
    ] as Array<{ setterUsername: string; tickCount: number }> | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useNavigation: () => ({
    setOptions: navigation.setOptions,
    goBack: navigation.goBack,
    addListener: (event: string, listener: () => void) => {
      if (event === 'removed') navigation.removed = listener;
      return () => {
        navigation.removed = null;
      };
    },
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options == null ? key : `${key}:${Object.values(options).join(',')}`,
  }),
}));
vi.mock('../../../src/components/filter-sheet/SetterPickerList', () => ({
  SetterPickerList: (props: SetterPickerListProps) => {
    picker.props = props;
    return createElement('div', { 'data-testid': 'picker' });
  },
}));
vi.mock('../../../src/hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing }: { trailing: { label: string; onPress: () => void } }) => {
    header.trailing = trailing;
  },
}));
vi.mock('../../../src/lib/graphql/hooks/use-user-logged-setters', () => ({
  useUserLoggedSetters: (userId: string | undefined, scope: unknown, search: string) => {
    settersHook.calls.push({ userId, scope, search });
    return settersHook.result;
  },
}));

import LogbookSettersScreen from '../[userId]/logbook-setters';

const received: LogbookSetterPicks[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  params.current = {
    userId: 'climber-1',
    handoffId: 'logbook-setters-7',
    setters: JSON.stringify(['sam']),
    boardType: 'kilter',
    layoutIds: JSON.stringify([1, 8]),
  };
  navigation.setOptions.mockReset();
  navigation.goBack.mockReset();
  navigation.removed = null;
  picker.props = null;
  header.trailing = null;
  settersHook.calls = [];
  settersHook.result.isError = false;
  settersHook.result.refetch.mockReset();
  received.length = 0;
  unsubscribe = subscribeToLogbookSetterSelection('logbook-setters-7', (picks) => received.push(picks));
});

afterEach(() => unsubscribe());

describe('LogbookSettersScreen', () => {
  it("lists the logbook's setters for its board scope, with the Logbook's picks checked", () => {
    render(createElement(LogbookSettersScreen));
    expect(settersHook.calls.at(-1)).toEqual({
      userId: 'climber-1',
      scope: { boardType: 'kilter', layoutIds: [1, 8] },
      search: '',
    });
    expect(picker.props?.setters).toEqual([
      { setterUsername: 'alex', count: 12 },
      { setterUsername: 'sam', count: 3 },
    ]);
    expect(picker.props?.selected).toEqual(['sam']);
    expect(picker.props?.formatCount(12)).toBe('mobile.logbook.setterPicker.tickCount:12');
    expect(navigation.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ headerShown: true, title: 'mobile.logbook.setterPicker.title' }),
    );
  });

  it('drops unreadable params rather than crashing', () => {
    params.current = { userId: 'climber-1', setters: 'not json', layoutIds: '[1, "x", 2.5]' };
    render(createElement(LogbookSettersScreen));
    expect(picker.props?.selected).toEqual([]);
    expect(settersHook.calls.at(-1)?.scope).toEqual({ boardType: '', layoutIds: [1] });
  });

  it('passes the typed search to the setters query', () => {
    render(createElement(LogbookSettersScreen));
    act(() => picker.props?.onSearchChange('al'));
    expect(settersHook.calls.at(-1)?.search).toBe('al');
  });

  it('toggles picks and stops at 20 with a note', () => {
    params.current.setters = JSON.stringify(Array.from({ length: 19 }, (_, index) => `setter-${index}`));
    render(createElement(LogbookSettersScreen));
    act(() => picker.props?.onToggle('alex'));
    expect(picker.props?.selected).toHaveLength(20);
    expect(picker.props?.notice).toBeUndefined();
    act(() => picker.props?.onToggle('sam'));
    expect(picker.props?.selected).toHaveLength(20);
    expect(picker.props?.selected).not.toContain('sam');
    expect(picker.props?.notice).toBe('mobile.logbook.setterPicker.limit:20');
    act(() => picker.props?.onToggle('alex'));
    expect(picker.props?.selected).toHaveLength(19);
    expect(picker.props?.notice).toBeUndefined();
    act(() => picker.props?.onClearAll());
    expect(picker.props?.selected).toEqual([]);
  });

  it('hands the picks back once, on the way out', () => {
    render(createElement(LogbookSettersScreen));
    act(() => picker.props?.onToggle('alex'));
    expect(received).toEqual([]);
    act(() => navigation.removed?.());
    expect(received).toEqual([{ setterUsernames: ['sam', 'alex'], apply: false }]);
  });

  it('"Show climbs" hands the picks back with apply and leaves, without a second hand-back', () => {
    render(createElement(LogbookSettersScreen));
    expect(header.trailing?.label).toBe('mobile.logbook.setterPicker.showResults');
    act(() => header.trailing?.onPress());
    act(() => header.trailing?.onPress());
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    act(() => navigation.removed?.());
    expect(received).toEqual([{ setterUsernames: ['sam'], apply: true }]);
  });

  it('hands the picks to nobody when opened without a Logbook to return to', () => {
    params.current = { ...params.current, handoffId: undefined };
    render(createElement(LogbookSettersScreen));
    act(() => navigation.removed?.());
    expect(received).toEqual([]);
  });

  it('offers a retry when the setters fail to load', () => {
    settersHook.result.isError = true;
    render(createElement(LogbookSettersScreen));
    expect(picker.props?.error?.message).toBe('mobile.logbook.setterPicker.error');
    picker.props?.error?.onRetry();
    expect(settersHook.result.refetch).toHaveBeenCalledTimes(1);
  });
});
