// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the snackbar branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', { 'data-view': 'true' }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-label': accessibilityLabel ?? '' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
      createElement('div', { 'data-animated': 'true', 'data-role': accessibilityRole ?? '' }, children),
  },
  FadeInDown: { duration: () => ({}) },
  FadeOutDown: { duration: () => ({}) },
}));

// Paper Snackbar → div exposing visible/duration/children and the action button.
type SnackbarAction = { label: string; onPress?: () => void; accessibilityLabel?: string };
type SnackbarMockProps = {
  visible?: boolean;
  duration?: number;
  onDismiss?: () => void;
  action?: SnackbarAction;
  wrapperStyle?: unknown;
  children?: ReactNode;
};
vi.mock('react-native-paper', () => ({
  Snackbar: ({ visible, duration, onDismiss, action, wrapperStyle, children }: SnackbarMockProps) =>
    createElement(
      'div',
      {
        'data-paper-snackbar': 'true',
        'data-visible': visible ? 'true' : 'false',
        'data-duration': String(duration ?? ''),
        'data-wrapper-style': JSON.stringify(wrapperStyle),
        onClick: onDismiss,
      },
      children,
      action
        ? createElement(
            'button',
            { 'data-action': 'true', 'data-action-label': action.accessibilityLabel ?? '', onClick: action.onPress },
            action.label,
          )
        : null,
    ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  spacing: { 2: 8, 3: 12, 4: 16 },
  shadowColor: '#000',
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    brandColors: { primary: '#6D28D9' },
    systemColors: { secondaryBackground: '#EEE', label: '#000' },
  }),
}));
vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 100 }),
}));

import { QueueAddedSnackbar } from '../QueueAddedSnackbar';

const base = { visible: true, nonce: 1, onDismiss: () => {}, onOpen: () => {} };

describe('QueueAddedSnackbar', () => {
  it('renders a Paper Snackbar with the Open action on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<QueueAddedSnackbar {...base} />);
    const snackbar = container.querySelector('[data-paper-snackbar]');
    expect(snackbar).not.toBeNull();
    expect(snackbar?.getAttribute('data-visible')).toBe('true');
    expect(snackbar?.getAttribute('data-duration')).toBe('4000'); // default duration mapped
    expect(snackbar?.textContent).toContain('mobile.queueSnackbar.added');
    const action = container.querySelector('[data-action]');
    expect(action?.textContent).toBe('mobile.queueSnackbar.open');
    expect(action?.getAttribute('data-action-label')).toBe('mobile.queueSnackbar.openAria');
    expect(container.querySelector('[data-animated]')).toBeNull();
  });

  it('positions the Material snackbar above the shared floating-control offset', () => {
    ctrl.variant = 'material';
    const { container } = render(<QueueAddedSnackbar {...base} />);
    expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-wrapper-style')).toContain(
      '"bottom":108',
    );
  });

  it('maps duration prop and routes the action to onOpen on Material', () => {
    ctrl.variant = 'material';
    const onOpen = vi.fn();
    const { container } = render(<QueueAddedSnackbar {...base} onOpen={onOpen} duration={2500} />);
    expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-duration')).toBe('2500');
    (container.querySelector('[data-action]') as HTMLElement).click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the Liquid Glass animated pill on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const onOpen = vi.fn();
    const { container } = render(<QueueAddedSnackbar {...base} onOpen={onOpen} />);
    const animated = container.querySelector('[data-animated]');
    expect(animated).not.toBeNull();
    expect(animated?.getAttribute('data-role')).toBe('alert');
    expect(container.textContent).toContain('mobile.queueSnackbar.added');
    expect(container.querySelector('[data-paper-snackbar]')).toBeNull();
    // The "Open" Pressable routes to onOpen.
    const openButton = container.querySelector('[data-label="mobile.queueSnackbar.openAria"]') as HTMLElement;
    openButton.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not render the glass pill when not visible on Liquid Glass', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<QueueAddedSnackbar {...base} visible={false} />);
    expect(container.querySelector('[data-animated]')).toBeNull();
  });

  it('auto-dismisses via timer on the Liquid Glass variant', () => {
    vi.useFakeTimers();
    ctrl.variant = 'liquidGlass';
    const onDismiss = vi.fn();
    render(<QueueAddedSnackbar {...base} onDismiss={onDismiss} duration={1000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
