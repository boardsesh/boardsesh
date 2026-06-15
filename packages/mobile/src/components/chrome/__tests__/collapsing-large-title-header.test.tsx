// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  pointerEvents?: string;
};
vi.mock('react-native', () => ({
  View: ({ children, onLayout, pointerEvents }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-has-layout': onLayout ? 'true' : 'false',
        'data-pointer': pointerEvents ?? '',
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 72 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gradient': 'true' }, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    systemColors: {
      label: '#000',
      separator: '#ccc',
      elevatedSurface: '#fff',
      background: '#fff',
    },
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
// ProgressiveBlur renders the iOS blur path under this mode (short-circuits the
// native a11y / glass-capability hooks it would otherwise pull in).
vi.mock('../../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => 'blur' }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, shadows: { sm: {} } }));
vi.mock('../GlassActionToolbar', () => ({ TOP_ACTION_SIZE: 48 }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-pressable': accessibilityLabel ?? '' }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { CollapsingLargeTitleHeader } from '../CollapsingLargeTitleHeader';

function makeProps(over: Partial<Parameters<typeof CollapsingLargeTitleHeader>[0]> = {}) {
  return {
    onHeightChange: vi.fn(),
    ...over,
  };
}

describe('CollapsingLargeTitleHeader', () => {
  it('renders the leftActions / rightActions / children slots when provided', () => {
    const { container } = render(
      <CollapsingLargeTitleHeader
        {...makeProps({
          leftActions: createElement('div', { 'data-testid': 'left' }),
          rightActions: createElement('div', { 'data-testid': 'right' }),
        })}
      >
        {createElement('div', { 'data-testid': 'children' })}
      </CollapsingLargeTitleHeader>,
    );

    expect(container.querySelector('[data-testid="left"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="right"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="children"]')).not.toBeNull();
  });

  it('omits the leftActions / rightActions / children slots when not provided', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps()} />);

    expect(container.querySelector('[data-testid="left"]')).toBeNull();
    expect(container.querySelector('[data-testid="right"]')).toBeNull();
    expect(container.querySelector('[data-testid="children"]')).toBeNull();
  });

  it('renders the persistent plain centre title when centerTitle is set', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps({ centerTitle: 'V4–V6 · Quality' })} />);
    expect(container.textContent).toContain('V4–V6 · Quality');
  });

  it('omits the centre title when centerTitle is not set', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps()} />);
    expect(container.textContent).not.toContain('V4–V6 · Quality');
  });

  it('renders the progressive blur behind the header islands', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps()} />);
    // ProgressiveBlur renders a MaskedView wrapping the BlurView (both stubbed in
    // the mobile test config). Its own colour-scheme behaviour is covered by
    // progressive-blur.test.tsx.
    expect(container.querySelector('[data-testid="masked-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="blur-view"]')).not.toBeNull();
  });

  it('reports its measured height through onHeightChange (container onLayout)', () => {
    const onHeightChange = vi.fn();
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps({ onHeightChange })} />);

    fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
    expect(onHeightChange).toHaveBeenCalledWith(72);
  });
});
