// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ color }: { color?: string }) => createElement('progress', { 'data-color': color }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: 'theme-secondary-label', tertiaryLabel: 'theme-tertiary-label' },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { separator: 'static-separator' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
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
  it('draws an idle glyph in the scheme-aware secondary label', () => {
    expect(renderButton({})).toBe('theme-secondary-label');
  });

  it('dims a disabled glyph to the tertiary label', () => {
    expect(renderButton({ disabled: true })).toBe('theme-tertiary-label');
  });

  it('keeps the caller accent while active', () => {
    expect(renderButton({ active: true, activeColor: '#FF00AA' })).toBe('#FF00AA');
  });
});
