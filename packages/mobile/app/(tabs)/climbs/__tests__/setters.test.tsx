// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SetterStat = { setterUsername: string; climbCount: number };

// Captured cleanup from the screen's useFocusEffect, so a test can simulate the
// screen losing focus (Done / swipe-back) and assert the handoff fires.
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
  },
}));
const emitMock = vi.hoisted(() => vi.fn());
const setterStats = vi.hoisted(() => ({
  data: [
    { setterUsername: 'alice', climbCount: 5 },
    { setterUsername: 'bob', climbCount: 3 },
  ] as SetterStat[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.value,
  useRouter: () => ({ back: vi.fn() }),
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
}));

vi.mock('../../../../src/lib/setter-filter-handoff', () => ({ emitSetterFilterSelection: emitMock }));

vi.mock('../../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', secondaryBackground: '#eee', label: '#000' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { separator: '#ccc', systemGray: '#999' },
}));
vi.mock('../../../../src/theme/typography', () => ({ textStyles: { callout: { fontSize: 16 } } }));
vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'data-role': accessibilityRole },
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

import SettersFilterScreen from '../setters';

beforeEach(() => {
  emitMock.mockClear();
  focus.cleanup = null;
  params.value.setters = undefined;
});

describe('SettersFilterScreen', () => {
  it('hands the selected setters back when the screen loses focus', () => {
    const { getByLabelText } = render(<SettersFilterScreen />);

    fireEvent.click(getByLabelText('alice'));

    expect(focus.cleanup).toBeTypeOf('function');
    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(['alice']);
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
});
