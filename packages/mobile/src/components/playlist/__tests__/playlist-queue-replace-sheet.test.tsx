// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

function readPaddingBottom(style: unknown): number | undefined {
  const layers = Array.isArray(style) ? style : [style];
  for (const layer of layers) {
    if (layer && typeof layer === 'object' && 'paddingBottom' in layer) {
      return (layer as { paddingBottom?: number }).paddingBottom;
    }
  }
  return undefined;
}

type ViewMockProps = { children?: ReactNode; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, style }: ViewMockProps) =>
    createElement('div', { 'data-view': 'true', 'data-pb': String(readPaddingBottom(style) ?? '') }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

type ModalSheetMockProps = {
  children?: ReactNode;
  visible?: boolean;
  enableDynamicSizing?: boolean;
  enablePanDownToClose?: boolean;
  onClose?: () => void;
};
// ModalSheet presents imperatively in the real app; here we render its children
// only while `visible` and expose a synthetic close button to exercise onClose.
vi.mock('../../ModalSheet', () => ({
  // `enablePanDownToClose` defaults to true in the real ModalSheet, so the mock
  // has to as well or "did this component lock the sheet?" reads backwards.
  ModalSheet: ({ children, visible, enableDynamicSizing, enablePanDownToClose = true, onClose }: ModalSheetMockProps) =>
    visible
      ? createElement(
          'div',
          {
            'data-sheet': 'true',
            'data-dynamic': enableDynamicSizing ? 'true' : 'false',
            'data-pan-close': enablePanDownToClose ? 'true' : 'false',
          },
          children,
          createElement('button', { 'data-sheet-close': 'true', onClick: onClose }),
        )
      : null,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count != null ? `${key}:${opts.count}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#fff', secondaryLabel: '#888' } }),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
}));

type ButtonMockProps = {
  title: string;
  onPress?: () => void;
  variant?: string;
  loading?: boolean;
  disabled?: boolean;
};
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, variant, loading, disabled }: ButtonMockProps) =>
    createElement('button', {
      disabled,
      onClick: onPress,
      'data-button': title,
      'data-variant': variant ?? 'filled',
      'data-loading': loading ? 'true' : 'false',
    }),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 3: 12, 4: 16, 6: 24 },
}));

import { PlaylistQueueReplaceSheet } from '../PlaylistQueueReplaceSheet';

function makeProps(overrides: Partial<Parameters<typeof PlaylistQueueReplaceSheet>[0]> = {}) {
  return {
    visible: true,
    futureQueueCount: 3,
    isReplacing: false,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

describe('PlaylistQueueReplaceSheet', () => {
  it('renders nothing until it has been made visible', () => {
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ visible: false })} />);
    expect(container.querySelector('[data-sheet]')).toBeNull();
  });

  it('shows the queued-climb warning and both actions', () => {
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ futureQueueCount: 5 })} />);
    expect(container.querySelector('[data-icon="queue"]')).not.toBeNull();
    expect(container.textContent).toContain('detail.queueReplace.title');
    expect(container.textContent).toContain('detail.queueReplace.message:5');
    expect(button(container, 'detail.queueReplace.cancel')).not.toBeNull();
    expect(button(container, 'detail.queueReplace.confirm')).not.toBeNull();
  });

  it('sizes to content and adds its own bottom spacing (the footerless ModalSheet wrapper composes the safe-area inset on top)', () => {
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps()} />);
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-dynamic')).toBe('true');
    // The content only carries spacing[3] (12); the footerless ModalSheet wrapper
    // adds insets.bottom via withSheetBottomInset, so the content must NOT re-add it
    // (doing so double-padded the sheet — see withSheetBottomInset + modal-sheet tests).
    expect(container.querySelector('[data-pb="12"]')).not.toBeNull();
    expect(container.querySelector('[data-pb="46"]')).toBeNull();
  });

  it('fires cancel and confirm callbacks from the buttons', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ onCancel, onConfirm })} />);
    fireEvent.click(button(container, 'detail.queueReplace.cancel')!);
    fireEvent.click(button(container, 'detail.queueReplace.confirm')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // #4622: confirming genuinely starts the page drain, and a throttled first
  // page can now back off for the length of a server window. A locked sheet with
  // a greyed-out Cancel for that long reads as a hung app, and `onCancel` aborts
  // the drain and its sleep — so the way out must stay reachable.
  it('keeps cancel and pan-to-close live while replacing', () => {
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ isReplacing: true })} />);
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-pan-close')).toBe('true');
    expect(button(container, 'detail.queueReplace.cancel')?.disabled).toBeFalsy();
    // Confirm still blocks a double-tap starting a second drain.
    expect(button(container, 'detail.queueReplace.confirm')?.getAttribute('data-loading')).toBe('true');
  });

  it('can be cancelled mid-replacement', () => {
    const onCancel = vi.fn();
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ isReplacing: true, onCancel })} />);
    fireEvent.click(button(container, 'detail.queueReplace.cancel')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('allows pan-to-close while idle', () => {
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps()} />);
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-pan-close')).toBe('true');
  });

  it('treats an external sheet close as cancellation', () => {
    const onCancel = vi.fn();
    const { container } = render(<PlaylistQueueReplaceSheet {...makeProps({ onCancel })} />);
    fireEvent.click(container.querySelector('[data-sheet-close]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
