// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SetterStat = { setterUsername: string; climbCount: number };

// Captured cleanup from the screen's useFocusEffect, so a test can simulate the
// screen losing focus (back / swipe-back) and assert the handoff fires.
const focus = vi.hoisted(() => ({ cleanup: null as null | (() => void) }));
// Mutable route params, so each test can vary the seeded selection.
const params = vi.hoisted(() => ({
  value: {
    boardName: 'kilter',
    layoutId: '1',
    sizeId: '10',
    setIds: '1,2',
    angle: '40',
    setters: undefined as string | undefined,
    countInput: undefined as string | undefined,
  },
}));
const emitMock = vi.hoisted(() => vi.fn());
// Captures navigation.setOptions calls so tests can assert the headerRight
// "Clear all" shows only while setters are selected; goBack is the footer's pop.
const navMock = vi.hoisted(() => ({
  setOptions: vi.fn(),
  goBack: vi.fn(),
  push: vi.fn(),
  addListener: vi.fn((_event: string, handler: () => void) => {
    focus.cleanup = handler;
    return () => {};
  }),
}));
const followMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../src/lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthors: () => ({ data: {}, setterNames: new Set(['alice']) }),
  useToggleAuthorFollow: () => ({ mutateAsync: followMock }),
}));
const setterStats = vi.hoisted(() => ({
  data: [
    { setterUsername: 'alice', climbCount: 5 },
    { setterUsername: 'bob', climbCount: 3 },
  ] as SetterStat[],
}));
// The count query: returns a count only while enabled, like the real hook, and
// records the input so tests can assert what the footer counts.
const countQuery = vi.hoisted(() => {
  const state = { count: 42 as number | undefined, isPlaceholderData: false };
  return {
    state,
    hook: vi.fn((_input: Record<string, unknown>, enabled: boolean) => ({
      data: enabled ? state.count : undefined,
      isPlaceholderData: enabled && state.isPlaceholderData,
    })),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count != null ? `${key}:${options.count}` : key),
  }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.value,
  // The screen drives the native header (title + headerRight) through setOptions.
  useNavigation: () => navMock,
  useRouter: () => navMock,
  // Run the effect immediately and stash its cleanup so the test can fire it.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    focus.cleanup = typeof cleanup === 'function' ? cleanup : null;
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data?: SetterStat[];
    renderItem: (info: { item: SetterStat }) => ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => {
    if (!data || data.length === 0) {
      return createElement('div', { 'data-testid': 'setter-list' }, ListEmptyComponent ?? null);
    }
    return createElement(
      'div',
      { 'data-testid': 'setter-list' },
      data.map((item) => createElement('div', { key: item.setterUsername }, renderItem({ item }))),
    );
  },
}));

vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useSetterStats: () => ({ data: setterStats.data, isLoading: false }),
  useSearchClimbsCount: countQuery.hook,
}));

vi.mock('../../../../src/lib/setter-filter-handoff', () => ({ emitSetterFilterSelection: emitMock }));

vi.mock('../../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#eee',
      label: '#000',
      secondaryLabel: '#666',
      separator: '#ccc',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../../src/theme/typography', () => ({ textStyles: { callout: { fontSize: 16 } } }));
vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'ios' },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    disabled,
  }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    disabled?: boolean;
  }) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'data-role': accessibilityRole },
      renderedChildren,
    );
  },
  TextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

import SettersFilterScreen from '../setters';

// The sheet's count input for its draft, as the filter sheet serializes it.
const sheetCountInput = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
  page: 0,
  pageSize: 1,
  sortBy: 'ascents',
  sortOrder: 'desc',
  minGrade: 16,
  setter: ['bob'],
};

beforeEach(() => {
  followMock.mockReset();
  followMock.mockResolvedValue(undefined);
  emitMock.mockClear();
  navMock.setOptions.mockClear();
  navMock.goBack.mockClear();
  countQuery.hook.mockClear();
  countQuery.state.count = 42;
  countQuery.state.isPlaceholderData = false;
  focus.cleanup = null;
  params.value.setters = undefined;
  params.value.countInput = JSON.stringify(sheetCountInput);
});

// The headerRight the screen last handed the native header via setOptions.
function lastHeaderRight(): unknown {
  const lastOptions = navMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
  return lastOptions?.headerRight;
}

function lastCountCall() {
  const lastCall = countQuery.hook.mock.calls.at(-1);
  if (!lastCall) throw new Error('The count query was never called');
  return { input: lastCall[0], enabled: lastCall[1] };
}

describe('SettersFilterScreen', () => {
  it('shows the headerRight Clear all only while setters are selected', () => {
    const { getByLabelText } = render(<SettersFilterScreen />);

    // Nothing selected yet → no headerRight.
    expect(lastHeaderRight()).toBeUndefined();

    // Select a setter → the Clear all headerRight appears.
    fireEvent.click(getByLabelText('alice'));
    expect(lastHeaderRight()).toBeTypeOf('function');
  });

  it('hands the selected setters back without apply when the screen is removed', () => {
    const { getByLabelText } = render(<SettersFilterScreen />);

    fireEvent.click(getByLabelText('alice'));

    expect(focus.cleanup).toBeTypeOf('function');
    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledTimes(1);
    // Exactly one argument: back keeps the picks as a sheet draft.
    expect(emitMock.mock.calls[0]).toEqual([['alice']]);
    expect(navMock.goBack).not.toHaveBeenCalled();
  });

  it('opens a setter playlist without handing the filter draft back', () => {
    const { getByText } = render(<SettersFilterScreen />);
    fireEvent.click(getByText('alice'));
    expect(navMock.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/setter/[username]',
      params: { username: 'alice' },
    });
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('follows an accountless setter from its row', async () => {
    const { getByText } = render(<SettersFilterScreen />);
    fireEvent.click(getByText('authors.follow'));
    expect(followMock).toHaveBeenCalledWith({ kind: 'setter', identifier: 'bob', follow: true });
    await waitFor(() =>
      expect((getByText('authors.follow').closest('button') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('gates only pending setters and keeps independent requests locked until each settles', async () => {
    let resolveBob!: () => void;
    let resolveAlice!: () => void;
    followMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveBob = resolve;
        }),
    );
    followMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAlice = resolve;
        }),
    );
    const { getByText } = render(<SettersFilterScreen />);
    const bob = getByText('authors.follow').closest('button') as HTMLButtonElement;
    const alice = getByText('authors.unfollow').closest('button') as HTMLButtonElement;
    fireEvent.click(bob);
    expect(bob.disabled).toBe(true);
    expect(alice.disabled).toBe(false);
    fireEvent.click(alice);
    expect(alice.disabled).toBe(true);
    fireEvent.click(bob);
    expect(followMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveAlice());
    expect(alice.disabled).toBe(false);
    expect(bob.disabled).toBe(true);
    await act(async () => resolveBob());
    expect(bob.disabled).toBe(false);
  });

  it('names the setter in each accessible follow action', () => {
    const { getByRole } = render(<SettersFilterScreen />);
    expect(getByRole('button', { name: 'authors.unfollow: alice' })).not.toBeNull();
    expect(getByRole('button', { name: 'authors.follow: bob' })).not.toBeNull();
  });

  it('shows mutation failure and unlocks its setter for retry', async () => {
    followMock.mockRejectedValueOnce(new Error('Offline write failed'));
    const { getByText, findByText } = render(<SettersFilterScreen />);
    fireEvent.click(getByText('authors.follow'));
    expect(await findByText('authors.followError')).not.toBeNull();
    expect((getByText('authors.follow').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('seeds the selection from the route param', () => {
    params.value.setters = JSON.stringify(['bob']);
    render(<SettersFilterScreen />);

    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledWith(['bob']);
  });

  it('toggles a seeded setter off', () => {
    params.value.setters = JSON.stringify(['alice']);
    const { getByLabelText } = render(<SettersFilterScreen />);

    fireEvent.click(getByLabelText('alice'));
    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledWith([]);
  });

  it('falls back to an empty selection for a malformed setters param', () => {
    params.value.setters = 'not-json';
    render(<SettersFilterScreen />);

    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledWith([]);
  });

  describe('Show N climbs footer', () => {
    it('labels the footer with the live count', () => {
      const { getByText } = render(<SettersFilterScreen />);

      expect(getByText('mobile.filter.showCount:42')).not.toBeNull();
      expect(lastCountCall().enabled).toBe(true);
    });

    it('shows the plain Apply label while the held count still belongs to the previous picks', () => {
      countQuery.state.isPlaceholderData = true;
      const { getByText, queryByText } = render(<SettersFilterScreen />);

      expect(getByText('mobile.filter.apply')).not.toBeNull();
      expect(queryByText('mobile.filter.showCount:42')).toBeNull();
    });

    it.each([
      ['missing', undefined],
      ['not JSON', 'not-json'],
      ['missing board fields', JSON.stringify({ boardName: 'kilter' })],
      ['an array', JSON.stringify([sheetCountInput])],
    ])('falls back to the plain Apply label when the count input is %s', (_label, countInput) => {
      params.value.countInput = countInput;
      const { getByText, queryByText } = render(<SettersFilterScreen />);

      expect(getByText('mobile.filter.apply')).not.toBeNull();
      expect(queryByText('mobile.filter.showCount:42')).toBeNull();
      expect(lastCountCall().enabled).toBe(false);
    });

    it('counts the picked setters on top of the sheet draft, and omits setter when none are picked', () => {
      params.value.setters = JSON.stringify(['bob']);
      const { getByLabelText } = render(<SettersFilterScreen />);

      fireEvent.click(getByLabelText('alice'));
      expect(lastCountCall().input).toEqual({ ...sheetCountInput, setter: ['bob', 'alice'] });

      fireEvent.click(getByLabelText('alice'));
      fireEvent.click(getByLabelText('bob'));
      const { setter: _sheetSetters, ...draftWithoutSetters } = sheetCountInput;
      expect(lastCountCall().input).toEqual(draftWithoutSetters);
      expect(lastCountCall().input).not.toHaveProperty('setter');
    });

    it('applies with the picks and pops the route', () => {
      const { getByLabelText, getByText } = render(<SettersFilterScreen />);

      fireEvent.click(getByLabelText('alice'));
      fireEvent.click(getByText('mobile.filter.showCount:42'));

      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledWith(['alice'], { apply: true });
      expect(navMock.goBack).toHaveBeenCalledTimes(1);
    });

    it('does not hand the selection back again when the pop blurs the screen, or on a second tap', () => {
      const { getByLabelText, getByText } = render(<SettersFilterScreen />);

      fireEvent.click(getByLabelText('alice'));
      fireEvent.click(getByText('mobile.filter.showCount:42'));
      fireEvent.click(getByText('mobile.filter.showCount:42'));
      focus.cleanup?.();

      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(navMock.goBack).toHaveBeenCalledTimes(1);
    });
  });
});
