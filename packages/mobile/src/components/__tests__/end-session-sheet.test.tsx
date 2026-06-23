// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode, type Ref } from 'react';

// Pulls `paddingBottom` out of a style that may be a single object or an array
// of layers (the component passes `[styles.content, { paddingBottom }]`).
function readPaddingBottom(style: unknown): number | undefined {
  const layers = Array.isArray(style) ? style : [style];
  for (const layer of layers) {
    if (layer && typeof layer === 'object' && 'paddingBottom' in layer) {
      return (layer as { paddingBottom?: number }).paddingBottom;
    }
  }
  return undefined;
}

const sheet = vi.hoisted(() => ({ expand: vi.fn() }));

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// BottomSheet → div exposing the dynamic-sizing / snap-point props so a test can
// assert the sheet is content-sized, with an imperative `expand` for the effect.
type SheetMockProps = {
  children?: ReactNode;
  enableDynamicSizing?: boolean;
  snapPoints?: (string | number)[];
};
type SheetViewMockProps = { children?: ReactNode; style?: unknown };
// SheetBackdrop pulls in react-native-gesture-handler + reanimated; this suite
// stubs the whole sheet, so stub the backdrop too (it isn't exercised here).
vi.mock('../SheetBackdrop', () => ({ SheetBackdrop: () => null }));
vi.mock('@gorhom/bottom-sheet', () => ({
  default: forwardRef(({ children, enableDynamicSizing, snapPoints }: SheetMockProps, ref: Ref<unknown>) => {
    useImperativeHandle(ref, () => ({ expand: sheet.expand }));
    return createElement(
      'div',
      {
        'data-sheet': 'true',
        'data-dynamic': enableDynamicSizing ? 'true' : 'false',
        'data-snappoints': snapPoints ? JSON.stringify(snapPoints) : '',
      },
      children,
    );
  }),
  BottomSheetView: ({ children, style }: SheetViewMockProps) =>
    createElement('div', { 'data-sheet-view': 'true', 'data-pb': String(readPaddingBottom(style) ?? '') }, children),
  BottomSheetBackdrop: () => createElement('div', { 'data-backdrop': 'true' }),
}));

// Gesture-nav phone: a non-zero bottom inset is the case the dynamic-sizing fix
// guards against (button row crowded under the home indicator).
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count != null ? `${key}:${opts.count}` : key),
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#fff', secondaryLabel: '#888' } }),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
}));

type ButtonMockProps = { title: string; onPress?: () => void; variant?: string; loading?: boolean };
vi.mock('../Button', () => ({
  Button: ({ title, onPress, variant, loading }: ButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      'data-button': title,
      'data-variant': variant ?? 'filled',
      'data-loading': loading ? 'true' : 'false',
    }),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../theme/tokens', () => ({
  spacing: { 3: 12, 4: 16, 6: 24 },
  sheetStyles: { indicator: {} },
}));

import { EndSessionSheet } from '../EndSessionSheet';

function makeProps(over: Partial<Parameters<typeof EndSessionSheet>[0]> = {}) {
  return {
    visible: true,
    onDismiss: vi.fn(),
    onConfirm: vi.fn(),
    isEnding: false,
    climbCount: 3,
    ...over,
  };
}

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

describe('EndSessionSheet', () => {
  beforeEach(() => {
    sheet.expand.mockClear();
  });

  it('renders nothing until it has been made visible', () => {
    const { container } = render(<EndSessionSheet {...makeProps({ visible: false })} />);
    expect(container.querySelector('[data-sheet]')).toBeNull();
  });

  it('shows the confirmation copy, climb count, and both actions when visible', () => {
    const { container } = render(<EndSessionSheet {...makeProps({ climbCount: 5 })} />);
    expect(container.querySelector('[data-icon="end.session"]')).not.toBeNull();
    // climbCount flows through the interpolated count key.
    expect(container.textContent).toContain('mobile.queue.climbCount:5');
    expect(button(container, 'summary.done')).not.toBeNull();
    expect(button(container, 'mobile.queue.endSession')).not.toBeNull();
  });

  it('sizes to content instead of a fixed snap point', () => {
    const { container } = render(<EndSessionSheet {...makeProps()} />);
    const sheetEl = container.querySelector('[data-sheet]') as HTMLElement;
    expect(sheetEl.getAttribute('data-dynamic')).toBe('true');
    expect(sheetEl.getAttribute('data-snappoints')).toBe('');
  });

  it('pads the content past the safe-area bottom inset (34) plus spacing[3] (12)', () => {
    const { container } = render(<EndSessionSheet {...makeProps()} />);
    const view = container.querySelector('[data-sheet-view]') as HTMLElement;
    expect(view.getAttribute('data-pb')).toBe('46');
  });

  it('fires onConfirm when End session is pressed', () => {
    const onConfirm = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onConfirm })} />);
    fireEvent.click(button(container, 'mobile.queue.endSession')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss when Done is pressed', () => {
    const onDismiss = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onDismiss })} />);
    fireEvent.click(button(container, 'summary.done')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('reflects the ending state on the confirm button', () => {
    const { container } = render(<EndSessionSheet {...makeProps({ isEnding: true })} />);
    expect(button(container, 'mobile.queue.endSession')?.getAttribute('data-loading')).toBe('true');
  });
});
