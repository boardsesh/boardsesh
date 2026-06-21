// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

type ViewMockProps = { children?: ReactNode; accessibilityRole?: string };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityRole }: ViewMockProps) =>
    createElement('div', { 'data-view': 'true', 'data-role': accessibilityRole ?? '' }, children),
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
  Portal: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-portal': 'true' }, children),
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

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  spacing: { 2: 8, 3: 12, 4: 16 },
  shadowColor: '#000',
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    brandColors: { primary: '#6D28D9' },
    systemColors: { secondaryBackground: '#EEE', label: '#000' },
  }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 100 }),
}));

import { UndoWallChangeSnackbar } from '../UndoWallChangeSnackbar';

const base = { visible: true, nonce: 1, onDismiss: () => {}, onUndo: () => {} };

describe('UndoWallChangeSnackbar', () => {
  it('renders the Material snackbar inside the Paper portal', () => {
    ctrl.variant = 'material';
    const { container } = render(<UndoWallChangeSnackbar {...base} />);
    expect(container.querySelector('[data-portal] [data-paper-snackbar]')).not.toBeNull();
    expect(container.textContent).toContain('mobile.boardPresence.wallChanged');
    expect(container.querySelector('[data-action]')?.textContent).toBe('mobile.boardPresence.undo');
  });

  it('positions the Material snackbar above the shared floating-control offset', () => {
    ctrl.variant = 'material';
    const { container } = render(<UndoWallChangeSnackbar {...base} />);
    expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-wrapper-style')).toContain(
      '"bottom":108',
    );
  });

  it('routes the Material action to onUndo', () => {
    ctrl.variant = 'material';
    const onUndo = vi.fn();
    const { container } = render(<UndoWallChangeSnackbar {...base} onUndo={onUndo} />);
    (container.querySelector('[data-action]') as HTMLElement).click();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('renders the Liquid Glass snackbar inside the Paper portal', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<UndoWallChangeSnackbar {...base} />);
    expect(container.querySelector('[data-portal] [data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-animated]')?.getAttribute('data-role')).toBe('alert');
    expect(container.textContent).toContain('mobile.boardPresence.wallChanged');
  });

  it('routes the Liquid Glass action to onUndo', () => {
    ctrl.variant = 'liquidGlass';
    const onUndo = vi.fn();
    const { container } = render(<UndoWallChangeSnackbar {...base} onUndo={onUndo} />);
    (container.querySelector('[data-label="mobile.boardPresence.undoAria"]') as HTMLElement).click();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
