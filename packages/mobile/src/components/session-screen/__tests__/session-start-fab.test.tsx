// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material', nativeGlass: true }));
// Captures the props the Material FAB and the glass capsule's surface/pressable
// receive so the test can assert variant routing + the tinted-glass contract.
const fab = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const glass = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({
    children,
    onLayout,
    style,
    testID,
    pointerEvents,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
    style?: unknown;
    testID?: string;
    pointerEvents?: string;
  }) =>
    createElement(
      'div',
      {
        ...(testID ? { 'data-testid': testID } : {}),
        'data-style': JSON.stringify(style),
        'data-pointer-events': pointerEvents ?? '',
        ref: (node: (HTMLElement & { fireLayout?: () => void }) | null) => {
          if (node && onLayout) node.fireLayout = () => onLayout({ nativeEvent: { layout: { height: 72 } } });
        },
      },
      children,
    ),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: { position: 'absolute' },
    hairlineWidth: 1,
  },
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('react-native-paper', () => ({
  FAB: (props: Record<string, unknown>) => {
    fab.props = props;
    return createElement('button', { 'data-fab': 'true', onClick: props.onPress as () => void }, String(props.label));
  },
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: (props: Record<string, unknown>) => {
    glass.props = props;
    return createElement('div', { 'data-glass': 'true' });
  },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: (props: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement(
      'button',
      { 'data-pressable': 'true', 'data-disabled': props.disabled ? 'true' : 'false', onClick: props.onPress },
      props.children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../icon-map', () => ({
  iconMap: { 'play.fill': { ios: 'play.fill', android: 'play' } },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    brandColors: { primary: '#6D28D9', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
    systemColors: { separator: '#333' },
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => ctrl.nativeGlass }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 5: 20 }, shadows: { sm: { shadowOpacity: 0.1 } } }));

import { SessionStartFab } from '../SessionStartFab';

function makeProps(over: Partial<Parameters<typeof SessionStartFab>[0]> = {}) {
  return {
    label: 'Start session',
    icon: 'play.fill' as const,
    onPress: vi.fn(),
    testID: 'pre-session-footer',
    bottomOffset: 130,
    onHeightChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  ctrl.variant = 'liquidGlass';
  ctrl.nativeGlass = true;
  fab.props = null;
  glass.props = null;
  haptics.light.mockClear();
});

describe('SessionStartFab', () => {
  describe('glass variant', () => {
    it('renders a brand-tinted glass capsule (not a FAB) anchored to the safe-area inset, box-none', () => {
      const { getByTestId, container } = render(<SessionStartFab {...makeProps()} />);

      expect(container.querySelector('[data-fab="true"]')).toBeNull();
      expect(container.querySelector('[data-glass="true"]')).not.toBeNull();
      // The glass is tinted with the brand hue — the Liquid Glass `.glassProminent` look.
      expect(glass.props?.tintColor).toBe('#6D28D9');
      const node = getByTestId('pre-session-footer');
      expect(node.getAttribute('data-pointer-events')).toBe('box-none');
      // The host supplies the variant-correct bottom offset via the prop.
      expect(node.getAttribute('data-style')).toContain('"bottom":130');
    });

    it('renders the label and the play glyph', () => {
      const { container } = render(<SessionStartFab {...makeProps({ label: 'Start session' })} />);
      expect(container.querySelector('[data-icon="play.fill"]')).not.toBeNull();
      expect(container.textContent).toContain('Start session');
    });

    it('swaps the play glyph for a spinner while loading', () => {
      const { container } = render(<SessionStartFab {...makeProps({ loading: true })} />);
      expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
      expect(container.querySelector('[data-icon="play.fill"]')).toBeNull();
    });

    it('fires onPress (with a haptic) through the capsule', () => {
      const onPress = vi.fn();
      const { container } = render(<SessionStartFab {...makeProps({ onPress })} />);
      (container.querySelector('[data-pressable="true"]') as HTMLButtonElement).click();
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(haptics.light).toHaveBeenCalledTimes(1);
    });

    it('does not fire onPress while disabled', () => {
      const onPress = vi.fn();
      const { container } = render(<SessionStartFab {...makeProps({ onPress, disabled: true })} />);
      (container.querySelector('[data-pressable="true"]') as HTMLButtonElement).click();
      expect(onPress).not.toHaveBeenCalled();
    });

    it('reports the measured container height through onHeightChange', () => {
      const onHeightChange = vi.fn();
      const { getByTestId } = render(<SessionStartFab {...makeProps({ onHeightChange })} />);
      const node = getByTestId('pre-session-footer') as HTMLElement & { fireLayout?: () => void };
      node.fireLayout?.();
      expect(onHeightChange).toHaveBeenCalledWith(72);
    });
  });

  describe('material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders the extended FAB (not the glass capsule) at the host bottomOffset, box-none', () => {
      const { getByTestId, container } = render(<SessionStartFab {...makeProps({ label: 'Start session' })} />);

      expect(container.querySelector('[data-glass="true"]')).toBeNull();
      expect(container.querySelector('[data-fab="true"]')).not.toBeNull();
      expect(fab.props?.icon).toBe('play'); // iconMap['play.fill'].android
      expect(fab.props?.label).toBe('Start session');
      expect(fab.props?.variant).toBe('primary');
      expect(fab.props?.mode).toBe('elevated');
      const node = getByTestId('pre-session-footer');
      expect(node.getAttribute('data-pointer-events')).toBe('box-none');
      expect(node.getAttribute('data-style')).toContain('"bottom":130');
    });

    it('forwards disabled / loading to the FAB', () => {
      render(<SessionStartFab {...makeProps({ disabled: true, loading: true })} />);
      expect(fab.props?.disabled).toBe(true);
      expect(fab.props?.loading).toBe(true);
    });
  });
});
