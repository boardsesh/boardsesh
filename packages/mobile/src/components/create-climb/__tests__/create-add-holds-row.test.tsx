// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 12: 48 },
  cardCorners: { borderRadius: 12 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { accent: '#7855FF', secondaryLabel: '#aaa', separator: '#555', error: '#f00' },
    surfaces: { plain: { tile: '#333' } },
  }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityState: { busy: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-busy': accessibilityState.busy },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityLiveRegion }: { children?: ReactNode; accessibilityLiveRegion?: string }) =>
    createElement('span', { 'aria-live': accessibilityLiveRegion }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', { role: 'progressbar' }) }));
import { CreateAddHoldsRow } from '../CreateAddHoldsRow';

describe('Add holds navigation row', () => {
  it('makes the explanatory sentence part of the same tap target', () => {
    const onPress = vi.fn();
    render(<CreateAddHoldsRow onPress={onPress} />);
    fireEvent.click(screen.getByText('mobile.create.holds.hint'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it.each([{ disabled: true }, { opening: true }])('blocks duplicate handoffs when unavailable %j', (props) => {
    const onPress = vi.fn();
    render(<CreateAddHoldsRow onPress={onPress} {...props} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
    if ('opening' in props) {
      expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true');
      expect(screen.getByRole('progressbar')).toBeTruthy();
    }
  });
  it('keeps an opening failure visible and the row available for retry', () => {
    const onPress = vi.fn();
    render(<CreateAddHoldsRow onPress={onPress} failed />);
    expect(screen.getByText('mobile.create.holds.openFailed').getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
