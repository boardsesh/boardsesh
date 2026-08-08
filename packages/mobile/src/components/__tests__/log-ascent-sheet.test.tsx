// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

// LogAscentSheet wraps `onClose` in a `handleClose` that fires
// `Quick Tick Dismissed` unless the just-closed tick was actually saved
// (tracked via a `savedRef` it hands down to QuickTickBar). Three paths all
// end up calling `handleClose` today: the X-button, native pan-down/backdrop
// (simulated here through the mocked `BottomSheetModal`'s `onChange`), and a
// successful save (simulated through the stubbed QuickTickBar).

// Mutable so a test can flip the platform; reset in beforeEach. The iOS branch
// is the one that pins a numeric column height (useSheetColumnStyle).
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', Version: '26.1' as string }));

vi.mock('react-native', () => ({
  Platform: platformMock,
  // Serialised so a test can read the style the sheet's column child gets.
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null), 'data-testid': testID }, children),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => createElement('button', { 'data-label': accessibilityLabel, onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// Stub BottomSheetModal: renders extra buttons that invoke the `onChange` prop —
// index -1 stands in for a native pan-down/backdrop dismiss, index 1 for the
// sheet settling on its taller (keyboard-extended) detent.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(
    ({ children, onChange }: { children?: ReactNode; onChange?: (index: number) => void }, _ref: Ref<unknown>) =>
      createElement('div', null, [
        createElement('button', {
          key: 'pandown',
          'data-testid': 'simulate-pandown',
          onClick: () => onChange?.(-1),
        }),
        createElement('button', {
          key: 'expand',
          'data-testid': 'simulate-expand',
          onClick: () => onChange?.(1),
        }),
        children,
      ]),
  ),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Isolate from the real presentation coordinator (covered by its own test);
// forward straight to the `onClose` LogAscentSheet passes in — a -1 onChange
// stands in for the native pan-down/backdrop-tap dismiss.
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ onClose }: { onClose?: () => void }) => ({
    onChange: (index: number) => {
      if (index === -1) onClose?.();
    },
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee', secondaryLabel: '#888' } }),
}));

vi.mock('../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 0 }) }));

vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: { QuickTickDismissed: 'Quick Tick Dismissed' },
}));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

// Stub QuickTickBar: exposes one button that simulates a completed save (sets
// savedRef then calls onDismiss, mirroring the real onSuccess handler) so the
// "save, don't double-count as a dismiss" path can be driven without the real
// form.
vi.mock('../play-drawer/QuickTickBar', () => ({
  QuickTickBar: ({
    onDismiss,
    savedRef,
    baseAscensionistCount,
  }: {
    onDismiss: () => void;
    savedRef?: { current: boolean };
    baseAscensionistCount: number;
  }) =>
    createElement('button', {
      'data-testid': 'simulate-save-success',
      'data-base-ascensionist-count': baseAscensionistCount,
      onClick: () => {
        if (savedRef) savedRef.current = true;
        onDismiss();
      },
    }),
}));

import { LogAscentSheet } from '../LogAscentSheet';
import { track } from '../../lib/analytics';

function renderSheet(overrides: Partial<Parameters<typeof LogAscentSheet>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    createElement(LogAscentSheet, {
      visible: true,
      onClose,
      climbUuid: 'climb-1',
      boardName: 'kilter',
      angle: 40,
      isMirror: false,
      isBenchmark: false,
      baseAscensionistCount: 10,
      layoutId: 7,
      ...overrides,
    }),
  );
  return { ...utils, onClose };
}

// The sheet's single in-flow child — the column QuickTickBar's scroll body and
// pinned save row are laid out inside. Addressed by testID, not by position:
// every mocked `View` carries `data-style`, so a positional lookup would
// silently start measuring a wrapper if one were ever added above the column.
function columnStyle(container: HTMLElement): Record<string, number> {
  const column = container.querySelector('[data-testid="log-ascent-column"]');
  if (!column) throw new Error('log-ascent-column not rendered');
  return JSON.parse(column.getAttribute('data-style') ?? 'null');
}

beforeEach(() => {
  platformMock.OS = 'ios';
  platformMock.Version = '26.1';
  vi.mocked(track).mockClear();
});

describe('LogAscentSheet dismiss tracking', () => {
  it('threads the immutable mutation-time count into QuickTickBar', () => {
    const { getByTestId } = renderSheet({ baseAscensionistCount: 37 });

    expect(getByTestId('simulate-save-success').getAttribute('data-base-ascensionist-count')).toBe('37');
  });

  it('fires Quick Tick Dismissed when the X-button closes an unsaved form', () => {
    const { container, onClose } = renderSheet();

    fireEvent.click(container.querySelector('[data-label="playView.tickBar.closeAria"]') as Element);

    expect(track).toHaveBeenCalledWith(
      'Quick Tick Dismissed',
      expect.objectContaining({ climbUuid: 'climb-1', layoutId: 7 }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires Quick Tick Dismissed on a simulated pan-down/backdrop dismiss', () => {
    const { getByTestId, onClose } = renderSheet();

    fireEvent.click(getByTestId('simulate-pandown'));

    expect(track).toHaveBeenCalledWith('Quick Tick Dismissed', expect.objectContaining({ climbUuid: 'climb-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends layoutId: null (not undefined) when the sheet has no layoutId', () => {
    const { container } = renderSheet({ layoutId: undefined });

    fireEvent.click(container.querySelector('[data-label="playView.tickBar.closeAria"]') as Element);

    expect(track).toHaveBeenCalledWith('Quick Tick Dismissed', expect.objectContaining({ layoutId: null }));
  });

  it('does not fire Quick Tick Dismissed when the tick was just saved', () => {
    const { getByTestId, onClose } = renderSheet();

    fireEvent.click(getByTestId('simulate-save-success'));

    expect(track).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets the saved flag on reopen, so a later abandon after a save still fires the event', () => {
    const onClose = vi.fn();
    const { getByTestId, rerender } = render(
      createElement(LogAscentSheet, {
        visible: true,
        onClose,
        climbUuid: 'climb-1',
        boardName: 'kilter',
        angle: 40,
        isMirror: false,
        isBenchmark: false,
        baseAscensionistCount: 10,
      }),
    );

    // Save once — no dismiss event, matches the "just saved" case above.
    fireEvent.click(getByTestId('simulate-save-success'));
    expect(track).not.toHaveBeenCalled();

    // Close, then reopen for a new tick on the same climb.
    rerender(
      createElement(LogAscentSheet, {
        visible: false,
        onClose,
        climbUuid: 'climb-1',
        boardName: 'kilter',
        angle: 40,
        isMirror: false,
        isBenchmark: false,
        baseAscensionistCount: 10,
      }),
    );
    rerender(
      createElement(LogAscentSheet, {
        visible: true,
        onClose,
        climbUuid: 'climb-1',
        boardName: 'kilter',
        angle: 40,
        isMirror: false,
        isBenchmark: false,
        baseAscensionistCount: 10,
      }),
    );

    // Abandon this second tick — without the reset-on-reopen effect this would
    // stay silently swallowed by the stale `savedRef.current === true` from
    // the first save.
    fireEvent.click(getByTestId('simulate-pandown'));
    expect(track).toHaveBeenCalledWith('Quick Tick Dismissed', expect.objectContaining({ climbUuid: 'climb-1' }));
  });
});

// QuickTickBar is a scroll body with a pinned Attempt/Send row, which only holds
// together if this column is clamped to the detent. On iOS the @expo/ui SwiftUI
// sheet host can propose an unbounded height, so a flex:1 column would size to
// its content: nothing scrolls and the save row lands off-screen (#3330). The
// window here is 844 with a 44pt top inset, so the iOS 26 base is 844 − 44 − 24 =
// 776; a detent is round(776 × fraction) − 20pt of chrome.
describe('LogAscentSheet detent bound', () => {
  it('pins the column to the 60% detent on iOS instead of letting it flex to content', () => {
    const { container } = renderSheet();

    expect(columnStyle(container)).toEqual({ height: 446 });
  });

  it('grows the column when the sheet settles on the taller 92% detent', () => {
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));

    expect(columnStyle(container)).toEqual({ height: 694 });
  });

  it('drops back to the shortest detent on close, so the next present starts bounded', () => {
    // PlayDrawer keeps this host mounted, so a stale 92% height would survive
    // into the next present and push the save row past the 60% detent.
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));
    fireEvent.click(getByTestId('simulate-pandown'));

    expect(columnStyle(container)).toEqual({ height: 446 });
  });

  it('leaves the column flexing on Android, where the Material sheet bounds it natively', () => {
    platformMock.OS = 'android';
    const { container } = renderSheet();

    expect(columnStyle(container)).toEqual({ flex: 1 });
  });
});
