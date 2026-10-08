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
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const themeState = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
afterEach(() => {
  themeState.variant = 'liquidGlass';
});

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ color }: { color?: string }) => createElement('progress', { 'data-color': color }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: themeState.variant,
    systemColors: {
      label: 'theme-label',
      secondaryLabel: 'theme-secondary-label',
      tertiaryLabel: 'theme-tertiary-label',
    },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { separator: 'static-separator' } }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { inlinePrimary: 56, inline: 44 } }));

import { ActionButton } from '../DrawerActionBar';

function renderButton(props: { disabled?: boolean; active?: boolean; activeColor?: string }) {
  const { container } = render(
    createElement(ActionButton, {
      iconName: 'favorite',
      size: 'sm',
      onPress: vi.fn(),
      accessibilityLabel: 'Like',
      ...props,
    }),
  );
  return container.querySelector('i')?.getAttribute('data-color');
}

describe('ActionButton glyph colour', () => {
  it.each(['liquidGlass', 'material'] as const)('draws enabled neutral glyphs in the %s foreground', (variant) => {
    themeState.variant = variant;
    expect(renderButton({})).toBe(variant === 'liquidGlass' ? 'theme-label' : 'theme-secondary-label');
  });

  it('dims a disabled glyph to the tertiary label', () => {
    expect(renderButton({ disabled: true })).toBe('theme-tertiary-label');
  });

  it('keeps the caller accent while active', () => {
    expect(renderButton({ active: true, activeColor: '#FF00AA' })).toBe('#FF00AA');
  });

  it('preserves the busy indicator foreground', () => {
    const { container } = render(
      createElement(ActionButton, {
        iconName: 'favorite',
        size: 'sm',
        onPress: vi.fn(),
        accessibilityLabel: 'Like',
        busy: true,
      }),
    );
    expect(container.querySelector('progress')?.getAttribute('data-color')).toBe('theme-secondary-label');
    expect(container.querySelector('i')).toBeNull();
  });
});
