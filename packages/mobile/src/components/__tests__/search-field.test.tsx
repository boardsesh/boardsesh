// @vitest-environment jsdom
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextInput: forwardRef<
    HTMLInputElement,
    {
      value?: string;
      placeholder?: string;
      accessibilityLabel?: string;
      onChangeText?: (text: string) => void;
      onSubmitEditing?: () => void;
    }
  >(function TextInputMock({ value, placeholder, accessibilityLabel, onChangeText, onSubmitEditing }, ref) {
    return createElement('input', {
      ref,
      value,
      placeholder,
      'aria-label': accessibilityLabel,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') onSubmitEditing?.();
      },
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
  },
}));
vi.mock('../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));
vi.mock('../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12 },
}));
vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { fill: '#eee', label: '#000', secondaryLabel: '#888' } }),
}));

import { SearchField } from '../SearchField';

function renderField(value: string, onChangeText = vi.fn()) {
  render(
    <SearchField
      value={value}
      onChangeText={onChangeText}
      placeholder="Search by title or number"
      clearAccessibilityLabel="Clear search"
    />,
  );
  return onChangeText;
}

describe('SearchField', () => {
  it('reports what the tester types', () => {
    const onChangeText = renderField('');

    fireEvent.change(screen.getByPlaceholderText('Search by title or number'), { target: { value: '5203' } });

    expect(onChangeText).toHaveBeenCalledWith('5203');
  });

  // Nothing to clear, so no button competing for the row — and no control that
  // does nothing when a screen reader reaches it.
  it('offers no clear button while the field is empty', () => {
    renderField('');

    expect(screen.queryByLabelText('Clear search')).toBeNull();
  });

  it('clears through the same callback once there is text', () => {
    const onChangeText = renderField('queue');

    fireEvent.click(screen.getByLabelText('Clear search'));

    expect(onChangeText).toHaveBeenCalledWith('');
  });

  // The placeholder doubles as the accessible name: the field carries no visible
  // label, so without this a screen reader announces an unnamed text field.
  it('names itself for a screen reader', () => {
    renderField('');

    expect(screen.getByLabelText('Search by title or number')).toBeTruthy();
  });
});
