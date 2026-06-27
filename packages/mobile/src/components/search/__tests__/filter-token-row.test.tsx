// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const hapticSelectionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-scrollview': 'true' }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { 'data-pill': 'true', 'aria-label': accessibilityLabel, onClick: onPress }, children),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', { 'data-icon': 'close' }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { separator: '#333' } }) }));
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

  it('labels each pill for removal using the token label', () => {
    const { container } = render(<FilterTokenRow tokens={[makeToken({ label: 'Quality' })]} />);
    const pill = container.querySelector('[data-pill]') as Element;
    expect(pill.getAttribute('aria-label')).toBe('mobile.search.removeFilterAria:Quality');
  });
});
