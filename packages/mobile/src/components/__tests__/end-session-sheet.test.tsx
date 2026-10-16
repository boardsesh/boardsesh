// @vitest-environment jsdom
vi.mock('../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
vi.mock('../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
import { describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';

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

const coordinatedSheet = vi.hoisted(() => ({
  onClose: undefined as (() => void) | undefined,
  visible: false,
}));

// Keep the original raw-sheet implementation renderable for regression proof.
// Both implementations must fail or pass on behavior, rather than missing mocks.
vi.mock('../../hooks/use-keyboard-height', () => ({ useKeyboardHeight: () => 0 }));
vi.mock('../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 34 }));
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ open, onClose }: { open: boolean; onClose?: () => void }) => {
    coordinatedSheet.visible = open;
    coordinatedSheet.onClose = onClose;
    return { onChange: vi.fn(), onFullyDismissed: vi.fn() };
  },
}));

vi.mock('../ModalSheet', () => ({
  ModalSheet: ({
    children,
    header,
    visible,
    snapPoints,
    scrollable,
    androidContentSized,
    enablePanDownToClose,
    onClose,
  }: {
    children?: ReactNode;
    header?: ReactNode;
    visible?: boolean;
    snapPoints?: string[];
    scrollable?: boolean;
    androidContentSized?: boolean;
    enablePanDownToClose?: boolean;
    onClose?: () => void;
  }) => {
    coordinatedSheet.onClose = onClose;
    return createElement(
      'div',
      {
        'data-sheet': 'true',
        'data-visible': String(visible),
        'data-snappoints': JSON.stringify(snapPoints),
        'data-scrollable': String(scrollable),
        'data-android-content-sized': String(androidContentSized),
        'data-pan-close': String(enablePanDownToClose),
      },
      createElement('header', null, header),
      createElement('main', null, children),
    );
  },
}));
type ViewMockProps = { children?: ReactNode; style?: unknown; testID?: string };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, style, testID }: ViewMockProps) =>
    createElement('div', { 'data-testid': testID, 'data-pb': String(readPaddingBottom(style) ?? '') }, children),
  // Present so a regression back to a KeyboardAvoidingView shows up below.
  KeyboardAvoidingView: ({ children }: ViewMockProps) => createElement('div', { 'data-kav': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// SESSION_NOTES_MAX_LENGTH flows onto the input's maxLength; mock the shared
// constant so this jsdom test doesn't pull the whole schema package.
vi.mock('@boardsesh/shared-schema', () => ({ SESSION_NOTES_MAX_LENGTH: 2000 }));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: ({
    children,
    snapPoints,
    enablePanDownToClose,
  }: {
    children?: ReactNode;
    snapPoints?: string[];
    enablePanDownToClose?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-sheet': 'true',
        'data-visible': String(coordinatedSheet.visible),
        'data-snappoints': JSON.stringify(snapPoints),
        'data-pan-close': String(enablePanDownToClose),
      },
      children,
    ),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetTextInput: ({ placeholder, value, onChangeText, accessibilityLabel, maxLength }: TextInputMockProps) =>
    createElement('input', {
      'data-textinput': 'true',
      'data-placeholder': placeholder ?? '',
      'data-aria': accessibilityLabel ?? '',
      'data-maxlength': String(maxLength ?? ''),
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
    brandColors: { error: '#f00' },
  }),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
}));

type ButtonMockProps = {
  title: string;
  onPress?: () => void;
  variant?: string;
  loading?: boolean;
  role?: string;
  disabled?: boolean;
};
vi.mock('../Button', () => ({
  Button: ({ title, onPress, variant, loading, role, disabled }: ButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      'data-button': title,
      'data-variant': variant ?? 'filled',
      'data-loading': loading ? 'true' : 'false',
      'data-role': role ?? 'default',
      'data-disabled': disabled ? 'true' : 'false',
    }),
}));

// The top bar's actions render as buttons keyed by their label, so the cases
// below press them the way they pressed the old row of buttons.
type TopBarActionMock = {
  label?: string;
  kind?: string;
  accessibilityLabel?: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  destructive?: boolean;
};
vi.mock('../SheetTopBar', () => ({
  SheetTopBar: ({
    title,
    leading,
    trailing,
  }: {
    title: string;
    leading?: TopBarActionMock;
    trailing?: TopBarActionMock;
  }) =>
    createElement(
      'div',
      { 'data-top-bar': title },
      [leading, trailing].map((action, index) =>
        action
          ? createElement('button', {
              key: index,
              onClick: action.onPress,
              'data-button': action.label ?? action.accessibilityLabel ?? action.kind,
              'data-slot': index === 0 ? 'leading' : 'trailing',
              'data-loading': action.loading ? 'true' : 'false',
              'data-disabled': action.disabled ? 'true' : 'false',
              'data-destructive': action.destructive ? 'true' : 'false',
            })
          : null,
      ),
    ),
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
    onLeave: vi.fn(),
    isEnding: false,
    isLeaving: false,
    climbCount: 3,
    notes: '',
    onNotesChange: vi.fn(),
    // The pre-#3502 sheet was end-only, so the cases below keep asserting that
    // shape by defaulting to the end mode.
    defaultMode: 'end' as const,
    canEnd: true,
    ...over,
  };
}

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

const textInput = (root: HTMLElement) => root.querySelector('[data-textinput]') as HTMLInputElement | null;

describe('EndSessionSheet', () => {
  it('delegates controlled visibility to the coordinated wrapper', () => {
    const { container } = render(<EndSessionSheet {...makeProps({ visible: false })} />);
    const sheetEl = container.querySelector('[data-sheet]') as HTMLElement;
    expect(sheetEl).not.toBeNull();
    expect(sheetEl.getAttribute('data-visible')).toBe('false');
  });

  it('shows the confirmation copy, climb count, and both actions when visible', () => {
    const { container } = render(<EndSessionSheet {...makeProps({ climbCount: 5 })} />);
    expect(container.querySelector('[data-icon="end.session"]')).not.toBeNull();
    // climbCount flows through the interpolated count key.
    expect(container.textContent).toContain('mobile.queue.climbCount:5');
    expect(button(container, 'mobile.queue.endSessionCancel')).not.toBeNull();
    expect(button(container, 'mobile.queue.endSession')).not.toBeNull();
  });

  it('bounds the scrolling body while pinning actions outside it', () => {
    const { container } = render(<EndSessionSheet {...makeProps()} />);
    const sheetEl = container.querySelector('[data-sheet]')!;
    expect(sheetEl.getAttribute('data-snappoints')).toBe('["50%","90%"]');
    expect(sheetEl.getAttribute('data-scrollable')).toBe('true');
    expect(sheetEl.getAttribute('data-android-content-sized')).toBe('true');
    expect(container.querySelector('header [data-top-bar]')).not.toBeNull();
    expect(container.querySelector('main [data-top-bar]')).toBeNull();
    // Only decorative padding lives here; the shared wrapper owns keyboard clearance.
    expect(container.querySelector('[data-testid="end-session-content"]')?.getAttribute('data-pb')).toBe('12');
  });

  it('retains typed recap across leave/end switches', () => {
    function ControlledSheet() {
      const [notes, onNotesChange] = useState('');
      return <EndSessionSheet {...makeProps({ notes, onNotesChange })} />;
    }
    const { container } = render(<ControlledSheet />);
    fireEvent.change(textInput(container)!, { target: { value: 'A long recap' } });
    fireEvent.click(button(container, 'mobile.queue.leaveInsteadAction')!);
    expect(textInput(container)).toBeNull();
    fireEvent.click(button(container, 'mobile.queue.endForEveryone')!);
    expect(textInput(container)?.value).toBe('A long recap');
  });

  it('puts End session in the top bar as the trailing action and the exit as leading', () => {
    const { container } = render(<EndSessionSheet {...makeProps()} />);
    expect(container.querySelector('[data-top-bar="mobile.queue.endSession"]')).not.toBeNull();
    expect(button(container, 'mobile.queue.endSession')?.getAttribute('data-slot')).toBe('trailing');
    expect(button(container, 'mobile.queue.endSessionCancel')?.getAttribute('data-slot')).toBe('leading');
  });

  it('draws End session as destructive but not Leave, which ends nothing for anyone else', () => {
    const endSheet = render(<EndSessionSheet {...makeProps()} />);
    expect(button(endSheet.container, 'mobile.queue.endSession')?.getAttribute('data-destructive')).toBe('true');
    endSheet.unmount();
    const leaveSheet = render(<EndSessionSheet {...makeProps({ defaultMode: 'leave' })} />);
    expect(button(leaveSheet.container, 'mobile.queue.leaveSessionAction')?.getAttribute('data-destructive')).toBe(
      'false',
    );
  });

  it('keeps the sheet up while an exit is in flight', () => {
    const onDismiss = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onDismiss, isEnding: true })} />);
    fireEvent.click(button(container, 'mobile.queue.endSessionCancel')!);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-pan-close')).toBe('false');
  });

  it.each(['ending', 'leaving'] as const)('clears controlled visibility when displaced while %s', (pendingExit) => {
    function ControlledSheet() {
      const [visible, setVisible] = useState(true);
      return (
        <EndSessionSheet
          {...makeProps({
            visible,
            onDismiss: () => setVisible(false),
            isEnding: pendingExit === 'ending',
            isLeaving: pendingExit === 'leaving',
          })}
        />
      );
    }
    const { container } = render(<ControlledSheet />);
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-pan-close')).toBe('false');
    // Coordinator displacement notifies the parent even when user dismissal is locked.
    act(() => coordinatedSheet.onClose?.());
    expect(container.querySelector('[data-sheet]')?.getAttribute('data-visible')).toBe('false');
  });

  it('fires onConfirm when End session is pressed', () => {
    const onConfirm = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onConfirm })} />);
    fireEvent.click(button(container, 'mobile.queue.endSession')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss when the top bar close is pressed', () => {
    const onDismiss = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onDismiss })} />);
    fireEvent.click(button(container, 'mobile.queue.endSessionCancel')!);
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

  // --- #3502: leave-vs-end ---------------------------------------------------

  describe('leave mode', () => {
    const leaveProps = (over: Partial<Parameters<typeof EndSessionSheet>[0]> = {}) =>
      makeProps({ defaultMode: 'leave', ...over });

    it('leads with Leave — not End — and calls onLeave', () => {
      const onLeave = vi.fn();
      const onConfirm = vi.fn();
      const { container } = render(<EndSessionSheet {...leaveProps({ onLeave, onConfirm })} />);
      expect(container.querySelector('[data-icon="leave.session"]')).not.toBeNull();
      expect(container.textContent).toContain('mobile.queue.leaveSessionConfirm');
      expect(button(container, 'mobile.queue.endSession')).toBeNull();

      fireEvent.click(button(container, 'mobile.queue.leaveSessionAction')!);
      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('hides the recap field — leaving produces no summary for it to land in', () => {
      const { container } = render(<EndSessionSheet {...leaveProps()} />);
      expect(textInput(container)).toBeNull();
    });

    // The regression this whole issue is about: before #3502 the second phone's
    // only exit ended the party for everyone. End must stay REACHABLE for a
    // creator (it's their session) but must never be the default here.
    it('keeps End reachable for a creator via the destructive switch link', () => {
      const onConfirm = vi.fn();
      const { container } = render(<EndSessionSheet {...leaveProps({ onConfirm, canEnd: true })} />);
      const switchLink = button(container, 'mobile.queue.endForEveryone');
      expect(switchLink).not.toBeNull();
      expect(switchLink?.getAttribute('data-variant')).toBe('text');
      expect(switchLink?.getAttribute('data-role')).toBe('destructive');

      fireEvent.click(switchLink!);
      // Now in end mode: the recap appears and End is the primary action.
      expect(textInput(container)).not.toBeNull();
      fireEvent.click(button(container, 'mobile.queue.endSession')!);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    // Deleting the `canEnd` gate makes this render the destructive switch to a
    // participant the server would refuse anyway — the foreign-joiner half of
    // the bug, which used to eject them with a generic "Action failed".
    it('offers no End affordance at all when canEnd is false', () => {
      const { container } = render(<EndSessionSheet {...leaveProps({ canEnd: false })} />);
      expect(button(container, 'mobile.queue.endForEveryone')).toBeNull();
      expect(button(container, 'mobile.queue.endSession')).toBeNull();
      expect(button(container, 'mobile.queue.leaveSessionAction')).not.toBeNull();
    });

    it('forces leave mode when canEnd is false even if the caller asked for end', () => {
      const { container } = render(<EndSessionSheet {...makeProps({ defaultMode: 'end', canEnd: false })} />);
      expect(button(container, 'mobile.queue.endSession')).toBeNull();
      expect(button(container, 'mobile.queue.leaveSessionAction')).not.toBeNull();
    });

    it('reflects the leaving state on the Leave button', () => {
      const { container } = render(<EndSessionSheet {...leaveProps({ isLeaving: true })} />);
      expect(button(container, 'mobile.queue.leaveSessionAction')?.getAttribute('data-loading')).toBe('true');
    });
  });

  // Device provenance resolves asynchronously, so `defaultMode` can change a
  // beat after the sheet is already open. Re-arming on that change would yank
  // the sheet out from under someone who has already tapped through.
  it('does not reset the chosen mode when defaultMode resolves late while open', () => {
    const { container, rerender } = render(<EndSessionSheet {...makeProps({ defaultMode: 'end' })} />);
    fireEvent.click(button(container, 'mobile.queue.leaveInsteadAction')!);
    expect(button(container, 'mobile.queue.leaveSessionAction')).not.toBeNull();

    // Provenance lands and flips the caller's preferred default.
    rerender(<EndSessionSheet {...makeProps({ defaultMode: 'end' })} />);
    expect(button(container, 'mobile.queue.leaveSessionAction')).not.toBeNull();
    expect(button(container, 'mobile.queue.endSession')).toBeNull();
  });

  it('re-arms to the default the next time it opens', () => {
    const { container, rerender } = render(<EndSessionSheet {...makeProps({ defaultMode: 'end' })} />);
    fireEvent.click(button(container, 'mobile.queue.leaveInsteadAction')!);
    expect(button(container, 'mobile.queue.endSession')).toBeNull();

    rerender(<EndSessionSheet {...makeProps({ visible: false, defaultMode: 'end' })} />);
    rerender(<EndSessionSheet {...makeProps({ visible: true, defaultMode: 'end' })} />);
    expect(button(container, 'mobile.queue.endSession')).not.toBeNull();
  });

  it('offers "just leave instead" from end mode, so ending is never the only exit', () => {
    const onLeave = vi.fn();
    const { container } = render(<EndSessionSheet {...makeProps({ onLeave })} />);
    const switchLink = button(container, 'mobile.queue.leaveInsteadAction');
    expect(switchLink).not.toBeNull();

    fireEvent.click(switchLink!);
    fireEvent.click(button(container, 'mobile.queue.leaveSessionAction')!);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
