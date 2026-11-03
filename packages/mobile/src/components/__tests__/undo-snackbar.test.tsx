// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode, type Ref, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared Undo body's screen-reader contract: with `focusUndoOnShow` it lands
// VoiceOver / TalkBack on the Undo control itself (both variants) half a second
// into every show, after a native menu has closed and the entrance fade is done,
// and holds the iOS announcement until then; and a duration change mid-show
// re-arms the dismiss timer on both variants.

const native = vi.hoisted(() => ({
  os: 'ios',
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  setAccessibilityFocus: vi.fn(),
  announceForAccessibility: vi.fn(),
  announceForAccessibilityWithOptions: vi.fn(),
  /** Every Paper Snackbar mount, with the duration it armed. */
  paperMounts: [] as number[],
}));

type HostProps = { children?: ReactNode; ref?: Ref<HTMLElement>; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  Platform: {
    get OS() {
      return native.os;
    },
  },
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  AccessibilityInfo: {
    setAccessibilityFocus: native.setAccessibilityFocus,
    announceForAccessibility: native.announceForAccessibility,
    announceForAccessibilityWithOptions: native.announceForAccessibilityWithOptions,
  },
  // The host node's own id stands in for its native tag.
  findNodeHandle: (instance: unknown) => (instance instanceof HTMLElement ? instance.id : null),
}));
vi.mock('react-native-reanimated', () => {
  const fade = { duration: () => fade };
  return {
    default: { View: ({ children }: HostProps) => createElement('div', null, children) },
    FadeInDown: fade,
    FadeOutDown: fade,
  };
});
vi.mock('react-native-paper', () => ({
  // Paper's own contract, as the comment in UndoSnackbar relies on it: the
  // dismiss timer is armed once per mount with the duration of that mount.
  Snackbar: ({
    children,
    action,
    duration,
  }: {
    children: ReactNode;
    duration: number;
    action: { label: string; onPress: () => void; touchableRef: RefObject<HTMLButtonElement | null> };
  }) => {
    useEffect(() => {
      native.paperMounts.push(duration);
      // Armed once per mount, by design: `duration` is deliberately not a dependency.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return createElement(
      'div',
      null,
      children,
      createElement('button', { id: 'paper-undo', ref: action.touchableRef, onClick: action.onPress }, action.label),
    );
  },
}));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, ref, onPress }: HostProps & { onPress: () => void }) =>
    createElement('button', { id: 'glass-undo', ref, onClick: onPress }, children),
}));
vi.mock('../Text', () => ({ Text: ({ children }: HostProps) => createElement('span', null, children) }));
vi.mock('../../theme/tokens', () => ({
  borderRadius: { lg: 16 },
  spacing: { 2: 8, 3: 12, 4: 16 },
  shadowColor: '#000',
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: native.variant,
    systemColors: { secondaryBackground: '#eee', label: '#000' },
    brandColors: { primary: '#06f' },
  }),
}));
vi.mock('../../theme/variants', async () => ({
  selectByVariant: (await import('../../theme/variants/select-by-variant')).selectByVariant,
}));

import { UndoSnackbar, type UndoSnackbarProps } from '../UndoSnackbar';

const baseProps: UndoSnackbarProps = {
  visible: true,
  nonce: 1,
  message: 'Queue cleared',
  undoLabel: 'Undo',
  undoAccessibilityLabel: 'Put the climbs back in the queue',
  onDismiss: () => {},
  onUndo: () => {},
  duration: 8000,
  bottom: 12,
};

const UNDO_ID = { liquidGlass: 'glass-undo', material: 'paper-undo' } as const;

beforeEach(() => {
  native.os = 'ios';
  native.variant = 'liquidGlass';
  native.paperMounts = [];
  native.setAccessibilityFocus.mockClear();
  native.announceForAccessibility.mockClear();
  native.announceForAccessibilityWithOptions.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// What the component waits before moving focus: past a native menu closing and
// the 220 ms / 200 ms entrance fades.
const FOCUS_DELAY_MS = 500;

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe.each(['liquidGlass', 'material'] as const)('UndoSnackbar focus (%s)', (variant) => {
  beforeEach(() => {
    native.variant = variant;
    vi.useFakeTimers();
  });

  it('lands the screen reader on the Undo control half a second after it shows', () => {
    render(createElement(UndoSnackbar, { ...baseProps, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS - 1);
    expect(native.setAccessibilityFocus).not.toHaveBeenCalled();
    advance(1);
    expect(native.setAccessibilityFocus).toHaveBeenCalledTimes(1);
    expect(native.setAccessibilityFocus).toHaveBeenCalledWith(UNDO_ID[variant]);
  });

  it('lands it again on the next show while the snackbar is still up', () => {
    const view = render(createElement(UndoSnackbar, { ...baseProps, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS);
    view.rerender(createElement(UndoSnackbar, { ...baseProps, nonce: 2, focusUndoOnShow: true }));
    expect(native.setAccessibilityFocus).toHaveBeenCalledTimes(1);
    advance(FOCUS_DELAY_MS);
    expect(native.setAccessibilityFocus).toHaveBeenCalledTimes(2);
    expect(native.setAccessibilityFocus).toHaveBeenLastCalledWith(UNDO_ID[variant]);
  });

  it('lands it again after a duration change, which remounts the Paper button', () => {
    const view = render(createElement(UndoSnackbar, { ...baseProps, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS);
    view.rerender(createElement(UndoSnackbar, { ...baseProps, duration: 80000, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS);
    expect(native.setAccessibilityFocus).toHaveBeenCalledTimes(2);
    expect(native.setAccessibilityFocus).toHaveBeenLastCalledWith(UNDO_ID[variant]);
  });

  it('does not move focus or announce when the snackbar hides before the delay', () => {
    const view = render(createElement(UndoSnackbar, { ...baseProps, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS - 1);
    view.rerender(createElement(UndoSnackbar, { ...baseProps, visible: false, focusUndoOnShow: true }));
    advance(FOCUS_DELAY_MS);
    expect(native.setAccessibilityFocus).not.toHaveBeenCalled();
    expect(native.announceForAccessibilityWithOptions).not.toHaveBeenCalled();
  });

  it('leaves focus alone without the flag and announces straight away, as before', () => {
    render(createElement(UndoSnackbar, baseProps));
    expect(native.announceForAccessibilityWithOptions).toHaveBeenCalledWith('Queue cleared', { queue: true });
    advance(FOCUS_DELAY_MS * 2);
    expect(native.setAccessibilityFocus).not.toHaveBeenCalled();
    expect(native.announceForAccessibilityWithOptions).toHaveBeenCalledTimes(1);
  });

  it('holds the queued VoiceOver announcement until focus lands, so the message follows "Undo"', () => {
    render(createElement(UndoSnackbar, { ...baseProps, focusUndoOnShow: true }));
    expect(native.announceForAccessibilityWithOptions).not.toHaveBeenCalled();
    advance(FOCUS_DELAY_MS);
    expect(native.announceForAccessibilityWithOptions).toHaveBeenCalledTimes(1);
    expect(native.announceForAccessibilityWithOptions).toHaveBeenCalledWith('Queue cleared', { queue: true });
    expect(native.setAccessibilityFocus.mock.invocationCallOrder[0]).toBeLessThan(
      native.announceForAccessibilityWithOptions.mock.invocationCallOrder[0],
    );
  });
});

describe('UndoSnackbar duration change mid-show', () => {
  it('re-arms the glass timer with the new duration from the moment it changes', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const view = render(createElement(UndoSnackbar, { ...baseProps, onDismiss }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    view.rerender(createElement(UndoSnackbar, { ...baseProps, onDismiss, duration: 80000 }));
    act(() => {
      vi.advanceTimersByTime(79999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('remounts the Paper snackbar so it arms the new duration, and only on a change', () => {
    native.variant = 'material';
    const view = render(createElement(UndoSnackbar, baseProps));
    view.rerender(createElement(UndoSnackbar, { ...baseProps, message: 'Queue cleared again' }));
    expect(native.paperMounts).toEqual([8000]);
    view.rerender(createElement(UndoSnackbar, { ...baseProps, duration: 80000 }));
    expect(native.paperMounts).toEqual([8000, 80000]);
  });
});
