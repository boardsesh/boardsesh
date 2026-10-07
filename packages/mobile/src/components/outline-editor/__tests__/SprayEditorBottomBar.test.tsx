// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('react-native-reanimated', () => {
  const animation = {
    springify: () => animation,
    damping: () => animation,
    stiffness: () => animation,
    mass: () => animation,
    duration: () => animation,
  };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children) },
    ZoomIn: animation,
    FadeIn: animation,
    FadeOut: animation,
    LinearTransition: animation,
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', secondaryLabel: '#555', separator: '#ccc' },
    brandColors: { primary: '#111', accent: '#222' },
  }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    testID,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress }, children),
}));
vi.mock('../SprayModeSwitcher', () => ({
  SprayModeSwitcher: ({
    mode,
    disabled,
    onChange,
  }: {
    mode: string;
    disabled: boolean;
    onChange: (mode: string) => void;
  }) =>
    createElement('div', {
      'data-testid': 'spray-mode-switcher',
      'data-mode': mode,
      'data-disabled': String(disabled),
      onClick: () => onChange('trace'),
    }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { xl: 24 } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 44 } }));
import { SprayEditorBottomBar } from '../SprayEditorBottomBar';

type BottomBarProps = Parameters<typeof SprayEditorBottomBar>[0];

function barProps(overrides: Partial<BottomBarProps> = {}): BottomBarProps {
  return {
    canUndo: true,
    canRedo: false,
    mode: 'select',
    onModeChange: vi.fn(),
    locked: false,
    bottomInset: 0,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  };
}

describe('the one-row bottom bar', () => {
  it('holds only Undo | Redo and the mode switcher: no counts, no Add, no Publish', () => {
    const { container, getByTestId, queryByTestId } = render(createElement(SprayEditorBottomBar, barProps()));
    expect(getByTestId('spray-mode-switcher')).toBeTruthy();
    expect(queryByTestId('spray-count-capsule')).toBeNull();
    // Undo is the only button the bar draws itself.
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(1);
  });

  it('hands the mode to the switcher and its choice back to the screen', () => {
    const onModeChange = vi.fn();
    const { getByTestId } = render(createElement(SprayEditorBottomBar, barProps({ mode: 'refine', onModeChange })));
    const switcher = getByTestId('spray-mode-switcher');
    expect(switcher.getAttribute('data-mode')).toBe('refine');
    switcher.click();
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith('trace');
  });

  it('locks the switcher with the rest of the bar', () => {
    const { getByTestId } = render(createElement(SprayEditorBottomBar, barProps({ locked: true })));
    expect(getByTestId('spray-mode-switcher').getAttribute('data-disabled')).toBe('true');
  });
});

describe('the Undo | Redo pill', () => {
  it('shows only Undo while there is nothing to redo', () => {
    const { queryByLabelText } = render(createElement(SprayEditorBottomBar, barProps()));
    expect(queryByLabelText('sprayEditor.bar.undo')).toBeTruthy();
    expect(queryByLabelText('sprayEditor.bar.redo')).toBeNull();
  });

  it('grows a Redo half that calls onRedo', () => {
    const onRedo = vi.fn();
    const { getByLabelText } = render(createElement(SprayEditorBottomBar, barProps({ canRedo: true, onRedo })));
    getByLabelText('sprayEditor.bar.redo').click();
    expect(onRedo).toHaveBeenCalledTimes(1);
  });
});
