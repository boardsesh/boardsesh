// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { act, createElement, createRef, forwardRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';

// Controls the resolved UI variant SearchHeader branches on.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'material' | 'liquidGlass' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextInput: forwardRef<
    HTMLInputElement,
    {
      value?: string;
      placeholder?: string;
      onChangeText?: (text: string) => void;
      onSubmitEditing?: () => void;
      onFocus?: () => void;
      onBlur?: () => void;
    }
  >(function TextInputMock({ value, placeholder, onChangeText, onSubmitEditing, onFocus, onBlur }, ref) {
    return createElement('input', {
      ref,
      value,
      placeholder,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') onSubmitEditing?.();
      },
      onFocus,
      onBlur,
    });
  }),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));

vi.mock('../GlassSurface', () => ({
  GlassSurface: () => createElement('div', { 'data-glass': 'true' }),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' }, variant: ctrl.variant }),
}));

vi.mock('../../theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#888', white: '#fff' },
}));

// Paper Searchbar forwards its ref to the inner TextInput; model that so the
// imperative blur/focus path can be exercised on the Material variant.
function readStyleField(style: unknown, field: string): string {
  const styleItems = Array.isArray(style) ? style : [style];
  const matchingStyle = styleItems.find(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null && field in item,
  );
  const fieldValue = matchingStyle?.[field];
  if (typeof fieldValue === 'number' || typeof fieldValue === 'string') return String(fieldValue);
  return '';
}

vi.mock('react-native-paper', () => ({
  Searchbar: forwardRef<
    HTMLInputElement,
    {
      value?: string;
      placeholder?: string;
      onChangeText?: (text: string) => void;
      style?: unknown;
      inputStyle?: unknown;
      elevation?: number;
    }
  >(function SearchbarMock({ value, placeholder, onChangeText, style, inputStyle, elevation }, ref) {
    return createElement('input', {
      ref,
      'data-paper': 'searchbar',
      'data-height': readStyleField(style, 'height'),
      'data-radius': readStyleField(style, 'borderRadius'),
      'data-elevation': String(elevation ?? ''),
      'data-has-input-style': inputStyle ? 'true' : 'false',
      value,
      placeholder,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value),
      readOnly: true,
    });
  }),
}));

import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';

describe('SearchHeader', () => {
  it('submits the current text when the keyboard search action fires', () => {
    ctrl.variant = 'liquidGlass';
    const onSubmit = vi.fn();
    const { getByPlaceholderText } = render(
      <SearchHeader
        placeholder="Search climbs"
        onChangeText={() => {}}
        onSubmit={onSubmit}
        onFocus={() => {}}
        onBlur={() => {}}
      />,
    );

    const input = getByPlaceholderText('Search climbs');
    fireEvent.change(input, { target: { value: 'Moonage' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('Moonage');
  });

  it('renders the Material Searchbar and keeps the imperative handle working', () => {
    ctrl.variant = 'material';
    const ref = createRef<SearchHeaderHandle>();
    const { container } = render(
      <SearchHeader
        ref={ref}
        placeholder="Search climbs"
        onChangeText={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
      />,
    );

    // Material path renders the Paper Searchbar (stub), not the glass capsule.
    const searchbar = container.querySelector('[data-paper="searchbar"]');
    expect(searchbar).not.toBeNull();
    expect(container.querySelector('[data-glass]')).toBeNull();
    expect(searchbar?.getAttribute('data-height')).toBe('44');
    expect(searchbar?.getAttribute('data-radius')).toBe('22');
    expect(searchbar?.getAttribute('data-elevation')).toBe('0');
    expect(searchbar?.getAttribute('data-has-input-style')).toBe('true');

    // getText/set({silent}) are backed by local state, so they work regardless of
    // Paper owning the inner TextInput.
    act(() => ref.current?.setText('Crimps', { silent: true }));
    expect(ref.current?.getText()).toBe('Crimps');
  });

  it('forwards blur/focus through the imperative handle on the Material path', () => {
    ctrl.variant = 'material';
    const ref = createRef<SearchHeaderHandle>();
    const { container } = render(
      <SearchHeader
        ref={ref}
        placeholder="Search climbs"
        onChangeText={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
      />,
    );
    const input = container.querySelector('[data-paper="searchbar"]');
    expect(input).not.toBeNull();

    // The handle proxies to Paper's forwarded TextInput ref — not a silent no-op.
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(input);
    act(() => ref.current?.blur());
    expect(document.activeElement).not.toBe(input);
  });
});
