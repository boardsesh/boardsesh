// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const hapticSelectionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-scrollview': 'true' }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'data-pill': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'aria-label': accessibilityLabel,
        onClick: onPress,
      },
      children,
    ),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', { 'data-icon': 'close' }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { separator: '#333', secondaryBackground: '#1C1C1E' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { filter?: string }) => (opts?.filter ? `${key}:${opts.filter}` : key),
  }),
}));

import { FilterTokenRow } from '../FilterTokenRow';
import type { FilterToken } from '../../../lib/filter-tokens';

function makeToken(over: Partial<FilterToken> = {}): FilterToken {
  return { key: 'grade', label: 'V4–V6', clear: vi.fn(), ...over };
}

describe('FilterTokenRow', () => {
  it('renders nothing when there are no tokens', () => {
    const { container } = render(<FilterTokenRow tokens={[]} />);
    expect(container.querySelector('[data-scrollview]')).toBeNull();
    expect(container.querySelector('[data-pill]')).toBeNull();
  });

  it('renders one removable pill per token', () => {
    const tokens = [makeToken({ key: 'grade', label: 'V4–V6' }), makeToken({ key: 'setter', label: 'By Matt' })];
    const { container } = render(<FilterTokenRow tokens={tokens} />);
    const pills = container.querySelectorAll('[data-pill]');
    expect(pills).toHaveLength(2);
    expect(pills[0].textContent).toContain('V4–V6');
  });

  it('clears just the pressed token (and fires one haptic)', () => {
    hapticSelectionMock.mockClear();
    const clearGrade = vi.fn();
    const clearSetter = vi.fn();
    const tokens = [
      makeToken({ key: 'grade', label: 'V4–V6', clear: clearGrade }),
      makeToken({ key: 'setter', label: 'By Matt', clear: clearSetter }),
    ];
    const { container } = render(<FilterTokenRow tokens={tokens} />);
    fireEvent.click(container.querySelectorAll('[data-pill]')[0]);
    expect(clearGrade).toHaveBeenCalledTimes(1);
    expect(clearSetter).not.toHaveBeenCalled();
    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
  });

  // On iOS 26 the row floats over the scrolling list (see NativeRootHeader), so a
  // border alone would leave the label on top of whatever row is behind it.
  it('gives each pill an opaque fill so its label reads over the list behind', () => {
    const { container } = render(<FilterTokenRow tokens={[makeToken()]} />);
    const pillStyle = JSON.parse(container.querySelector('[data-pill]')?.getAttribute('data-style') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(pillStyle).toMatchObject({ backgroundColor: '#1C1C1E', borderColor: '#333', borderWidth: 1 });
  });

  it('labels each pill for removal using the token label', () => {
    const { container } = render(<FilterTokenRow tokens={[makeToken({ label: 'Quality' })]} />);
    const pill = container.querySelector('[data-pill]') as Element;
    expect(pill.getAttribute('aria-label')).toBe('mobile.search.removeFilterAria:Quality');
  });
});
