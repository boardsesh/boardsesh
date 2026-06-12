// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: { label: '#000', fill: '#eee', separator: '#ccc' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ shadows: { sm: {} } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48 } }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) =>
    createElement('span', { 'data-text-color': typeof color === 'string' ? color : '' }, children),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) =>
    createElement('button', { 'data-pill': 'true' }, children),
}));
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({ iconName, iconColor }: { iconName: string; iconColor?: unknown }) =>
    createElement('button', {
      'data-fab': 'true',
      'data-icon': iconName,
      'data-icon-color': typeof iconColor === 'string' ? iconColor : '',
    }),
}));

import { PlaylistEditDoneButton } from '../PlaylistEditDoneButton';

describe('PlaylistEditDoneButton', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('uses neutral glyph and label colors in expanded glass mode', () => {
    const { container } = render(<PlaylistEditDoneButton onPress={vi.fn()} />);

    expect(container.querySelector('[data-icon="check.small"]')?.getAttribute('data-color')).toBe('#000');
    expect(container.querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe('#000');
    expect(container.textContent).toContain('editClimbs.done');
  });

  it('uses a neutral glyph color when collapsed to a glass icon button', () => {
    const { container } = render(<PlaylistEditDoneButton onPress={vi.fn()} collapsed />);

    expect(container.querySelector('[data-fab="true"]')?.getAttribute('data-icon-color')).toBe('#000');
  });

  it('keeps the Material Done affordance on primary color', () => {
    ctrl.variant = 'material';
    const { container, rerender } = render(<PlaylistEditDoneButton onPress={vi.fn()} />);

    expect(container.querySelector('[data-icon="check.small"]')?.getAttribute('data-color')).toBe('#6D28D9');
    expect(container.querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe('#6D28D9');

    rerender(<PlaylistEditDoneButton onPress={vi.fn()} collapsed />);
    expect(container.querySelector('[data-fab="true"]')?.getAttribute('data-icon-color')).toBe('#6D28D9');
  });
});
