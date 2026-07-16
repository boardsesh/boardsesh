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
  KeyboardAvoidingView: ({ children }: ViewMockProps) => createElement('div', { 'data-kav': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// SESSION_NOTES_MAX_LENGTH flows onto the input's maxLength; mock the shared
// constant so this jsdom test doesn't pull the whole schema package.
vi.mock('@boardsesh/shared-schema', () => ({ SESSION_NOTES_MAX_LENGTH: 2000 }));

// BottomSheet → div exposing the dynamic-sizing / snap-point props so a test can
// assert the sheet is content-sized, with an imperative `expand` for the effect.
type SheetMockProps = {
  children?: ReactNode;
  enableDynamicSizing?: boolean;
  snapPoints?: (string | number)[];
  index?: number;
};
type SheetViewMockProps = { children?: ReactNode; style?: unknown };
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(({ children, enableDynamicSizing, snapPoints, index }: SheetMockProps, ref: Ref<unknown>) => {
    useImperativeHandle(ref, () => ({ expand: sheet.expand }));
    return createElement(
      'div',
      {
        'data-sheet': 'true',
        'data-dynamic': enableDynamicSizing ? 'true' : 'false',
        'data-snappoints': snapPoints ? JSON.stringify(snapPoints) : '',
        'data-index': index === undefined ? '' : String(index),
      },
      children,
    );
  }),
  BottomSheetView: ({ children, style }: SheetViewMockProps) =>
    createElement('div', { 'data-sheet-view': 'true', 'data-pb': String(readPaddingBottom(style) ?? '') }, children),
  BottomSheetTextInput: ({ placeholder, value, onChangeText, accessibilityLabel, maxLength }: TextInputMockProps) =>
    createElement('input', {
      'data-textinput': 'true',
      'data-placeholder': placeholder ?? '',
      'data-aria': accessibilityLabel ?? '',
      'data-maxlength': maxLength === undefined ? '' : String(maxLength),
      value: value ?? '',
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));

type TextInputMockProps = {
  placeholder?: string;
  value?: string;
  onChangeText?: (text: string) => void;
  accessibilityLabel?: string;
  maxLength?: number;
};

// Isolate the sheet from the presentation coordinator (its serialization is
// covered by sheet-presentation-provider.test.tsx). The sheet is always mounted
// and opened/closed by the coordinator; these tests drive close via the Done
// button's onDismiss prop, so a no-op managed handle is enough.
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ onClose }: { onClose?: () => void }) => ({
    onChange: (index: number) => {
      if (index === -1) onClose?.();
    },
    onFullyDismissed: () => {},
    handle: {
      present: () => {},
      dismiss: () => {},
      close: () => {},
      forceClose: () => {},
      snapToIndex: () => {},
      snapToPosition: () => {},
      expand: () => {},
      collapse: () => {},
    },
  }),
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
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      secondaryLabel: '#888',
      fill: '#eee',
      label: '#000',
      tertiaryLabel: '#aaa',
    },
  }),
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
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
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
    notes: '',
    onNotesChange: vi.fn(),
    ...over,
  };
}

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

const textInput = (root: HTMLElement) => root.querySelector('[data-textinput]') as HTMLInputElement | null;

describe('EndSessionSheet', () => {
  beforeEach(() => {
    sheet.expand.mockClear();
  });

  it('stays mounted but closed (index -1) until the coordinator opens it', () => {
    // The sheet is always mounted now — present/dismiss route through the
    // coordinator — so it renders at the closed index rather than returning null.
    const { container } = render(<EndSessionSheet {...makeProps({ visible: false })} />);
    const sheetEl = container.querySelector('[data-sheet]') as HTMLElement;
    expect(sheetEl).not.toBeNull();
    expect(sheetEl.getAttribute('data-index')).toBe('-1');
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

  it('renders the optional recap input with its placeholder, aria label, and max length', () => {
    const { container } = render(<EndSessionSheet {...makeProps()} />);
    const input = textInput(container);
    expect(input).not.toBeNull();
    expect(input?.getAttribute('data-placeholder')).toBe('mobile.queue.endSessionCommentPlaceholder');
    expect(input?.getAttribute('data-aria')).toBe('mobile.queue.endSessionCommentAria');
    expect(input?.getAttribute('data-maxlength')).toBe('2000');
  });

  it('fires onNotesChange as the recap is typed', () => {
    const onNotesChange = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onNotesChange })} />);
    fireEvent.change(textInput(container)!, { target: { value: 'great sesh' } });
    expect(onNotesChange).toHaveBeenCalledWith('great sesh');
  });

  it('lets End fire with an empty recap — typing never blocks or validates', () => {
    const onConfirm = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ notes: '', onConfirm })} />);
    const endButton = button(container, 'mobile.queue.endSession');
    // The button is never disabled by an empty field (no disabled attr wired).
    expect(endButton?.getAttribute('data-loading')).toBe('false');
    fireEvent.click(endButton!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
