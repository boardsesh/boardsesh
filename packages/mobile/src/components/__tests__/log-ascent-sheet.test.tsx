// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

// LogAscentSheet wraps `onClose` in a `handleClose` that fires
// `Quick Tick Dismissed` unless the just-closed tick was actually saved
// (tracked via a `savedRef` it hands to useQuickTickForm). Three paths all end
// up calling `handleClose` today: the header's close button, native
// pan-down/backdrop (simulated here through the mocked `BottomSheetModal`'s
// `onChange`), and a successful save (simulated through the stubbed form hook).
//
// The sheet chrome is ModalSheet now, so the #3330 detent bound is re-derived
// through it: the column-bearing view is ModalSheet's KeyboardAvoidingView, and
// the detent tests below assert its height at each snap point exactly as they
// used to assert the hand-rolled column's.

// Mutable so a test can flip the platform; reset in beforeEach. The iOS branch
// is the one that pins a numeric column height (useSheetColumnStyle).
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', Version: '26.1' as string }));

// Captures what LogAscentSheet handed the form hook, so the climb/board
// plumbing can be asserted without running the real hook (tested next door in
// use-quick-tick-form.test.tsx).
const formInput = vi.hoisted(() => ({
  current: null as null | {
    climbUuid: string;
    baseAscensionistCount: number;
    onDismiss: () => void;
    savedRef?: { current: boolean };
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformMock.OS;
    },
    get Version() {
      return platformMock.Version;
    },
    select: (options: { ios?: unknown; android?: unknown }) =>
      platformMock.OS === 'ios' ? options.ios : options.android,
  },
  // Serialised so a test can read the style a view was handed.
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null), 'data-testid': testID }, children),
  // ModalSheet's single in-flow child once a header or footer is present — the
  // view that carries the detent bound.
  KeyboardAvoidingView: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null), 'data-testid': 'sheet-column' }, children),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => createElement('button', { 'data-label': accessibilityLabel, onClick: onPress }, children),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    flatten: function flatten(style: unknown): Record<string, unknown> | undefined {
      if (style == null || style === false) return undefined;
      if (Array.isArray(style)) {
        const out: Record<string, unknown> = {};
        for (const entry of style) {
          const flat = flatten(entry);
          if (flat) Object.assign(out, flat);
        }
        return out;
      }
      return style as Record<string, unknown>;
    },
  },
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
  BottomSheetScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'sheet-body' }, children),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Isolate from the real presentation coordinator (covered by its own test);
// forward straight to the `onClose` ModalSheet was given — a -1 onChange stands
// in for the native pan-down/backdrop-tap dismiss.
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ onClose }: { onClose?: () => void }) => ({
    onChange: (index: number) => {
      if (index === -1) onClose?.();
    },
    onFullyDismissed: vi.fn(),
    handle: { present: vi.fn(), dismiss: vi.fn(), close: vi.fn() },
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', secondaryLabel: '#888', separator: '#ccc', secondaryBackground: '#fff' },
    sheet: { handleStyle: {} },
    sheetSurface: '#181225',
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticMedium: vi.fn() }));
vi.mock('../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 0 }) }));

// The tick chrome, stubbed down to the props LogAscentSheet is responsible for
// wiring. The metrics module is the REAL one, so the detent assertions below
// run against the shipped CREATE_TICK_SNAP_POINTS rather than a copy.
vi.mock('../tick', async () => {
  const metrics = await vi.importActual<typeof import('../tick/tick-sheet-metrics')>('../tick/tick-sheet-metrics');
  return {
    ...metrics,
    TickSheetHeader: ({
      title,
      subtitle,
      gradeColor,
      onClose,
      closeAccessibilityLabel,
    }: {
      title: string;
      subtitle?: string;
      gradeColor?: string | null;
      onClose: () => void;
      closeAccessibilityLabel: string;
    }) =>
      createElement('button', {
        'data-testid': 'tick-header',
        'data-label': closeAccessibilityLabel,
        'data-title': title,
        'data-subtitle': subtitle ?? '',
        'data-grade-color': gradeColor ?? '',
        onClick: onClose,
      }),
    TickActionBar: ({
      primary,
      secondary,
      error,
    }: {
      primary: { title: string; onPress: () => void; accessibilityLabel?: string };
      secondary?: { title: string; onPress: () => void; accessibilityLabel?: string };
      error?: string | null;
    }) =>
      createElement(
        'div',
        { 'data-testid': 'tick-action-bar', 'data-error': error ?? '' },
        createElement('button', {
          key: 'primary',
          'data-testid': 'simulate-save-success',
          'data-label': primary.accessibilityLabel,
          'data-title': primary.title,
          onClick: primary.onPress,
        }),
        secondary
          ? createElement('button', {
              key: 'secondary',
              'data-testid': 'tick-attempt',
              'data-label': secondary.accessibilityLabel,
              'data-title': secondary.title,
              onClick: secondary.onPress,
            })
          : null,
      ),
  };
});

// Stub the form hook: `onSave` mirrors the real success path (flip savedRef,
// then call onDismiss) so the "save, don't double-count as a dismiss" branch can
// be driven without the mutation, the logbook and the analytics behind it.
vi.mock('../play-drawer/use-quick-tick-form', () => ({
  useQuickTickForm: (input: {
    climbUuid: string;
    baseAscensionistCount: number;
    onDismiss: () => void;
    savedRef?: { current: boolean };
  }) => {
    formInput.current = input;
    return {
      tickState: { quality: null, difficulty: undefined, attemptCount: 1 },
      comment: '',
      climbedAt: new Date('2025-06-01T08:00:00.000Z'),
      maximumClimbedAtDate: new Date('2025-06-01T08:00:00.000Z'),
      grades: [],
      consensusDifficultyId: undefined,
      resolvedGradeName: undefined,
      ascentType: 'send',
      saveLabel: 'playView.tickBar.sendSaveLabel',
      isPending: false,
      lastError: null,
      onQualitySelect: vi.fn(),
      onGradeSelect: vi.fn(),
      onTriesSelect: vi.fn(),
      onCommentChange: vi.fn(),
      onClimbedAtChange: vi.fn(),
      onFutureAdjusted: vi.fn(),
      onSave: () => {
        if (input.savedRef) input.savedRef.current = true;
        input.onDismiss();
      },
      onAttempt: vi.fn(),
    };
  },
}));

vi.mock('../play-drawer/QuickTickBar', () => ({
  QuickTickBar: () => createElement('div', { 'data-testid': 'tick-fields' }),
}));

vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: { QuickTickDismissed: 'Quick Tick Dismissed' },
}));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

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

// The sheet's single in-flow child — the column the scroll body and the pinned
// action bar are laid out inside. Owned by ModalSheet now (the mocked
// KeyboardAvoidingView), addressed by testID rather than by position.
function columnStyle(container: HTMLElement): Record<string, number> {
  const column = container.querySelector('[data-testid="sheet-column"]');
  if (!column) throw new Error('sheet column not rendered');
  return JSON.parse(column.getAttribute('data-style') ?? 'null');
}

beforeEach(() => {
  platformMock.OS = 'ios';
  platformMock.Version = '26.1';
  formInput.current = null;
  vi.mocked(track).mockClear();
});

describe('LogAscentSheet dismiss tracking', () => {
  it('threads the immutable mutation-time count into the form', () => {
    renderSheet({ baseAscensionistCount: 37 });

    expect(formInput.current?.baseAscensionistCount).toBe(37);
  });

  it('fires Quick Tick Dismissed when the close button closes an unsaved form', () => {
    const { container, onClose } = renderSheet();

    fireEvent.click(container.querySelector('[data-label="mobile.tick.closeAria"]') as Element);

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

    fireEvent.click(container.querySelector('[data-label="mobile.tick.closeAria"]') as Element);

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

describe('LogAscentSheet header', () => {
  it('titles the sheet with the climb the climber is logging', () => {
    const { getByTestId } = renderSheet({ climbName: 'Floats Your Boat', consensusGradeName: 'V3' });

    const header = getByTestId('tick-header');
    expect(header.getAttribute('data-title')).toBe('Floats Your Boat');
    expect(header.getAttribute('data-subtitle')).toBe('mobile.tick.consensusMeta');
    // The identity bar paints the consensus grade until the climber picks one.
    expect(header.getAttribute('data-grade-color')).not.toBe('');
  });

  it('falls back to a titled sheet rather than an empty band when no climb name came through', () => {
    const { getByTestId } = renderSheet({ climbName: undefined, consensusGradeName: undefined });

    const header = getByTestId('tick-header');
    expect(header.getAttribute('data-title')).toBe('mobile.tick.fallbackTitle');
    expect(header.getAttribute('data-subtitle')).toBe('mobile.tick.angleMeta');
  });
});

// The form is a scroll body with a pinned Attempt/Send row, which only holds
// together if ModalSheet's column is clamped to the detent. On iOS the @expo/ui
// SwiftUI sheet host can propose an unbounded height, so a flex:1 column would
// size to its content: nothing scrolls and the action bar lands off-screen
// (#3330). The window here is 844 with a 44pt top inset, so the iOS 26 base is
// 844 − 44 − 24 = 776; a detent is round(776 × fraction) − 20pt of chrome.
describe('LogAscentSheet detent bound', () => {
  it('pins the column to the 65% create detent on iOS instead of letting it flex to content', () => {
    const { container } = renderSheet();

    expect(columnStyle(container)).toEqual({ height: 484 });
  });

  it('grows the column when the sheet settles on the taller 92% detent', () => {
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));

    expect(columnStyle(container)).toEqual({ height: 694 });
  });

  it('drops back to the shortest detent on close, so the next present starts bounded', () => {
    // PlayDrawer keeps this host mounted, so a stale 92% height would survive
    // into the next present and push the action bar past the first detent.
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));
    fireEvent.click(getByTestId('simulate-pandown'));

    expect(columnStyle(container)).toEqual({ height: 484 });
  });

  it('caps the column at window − topInset − chrome on Android (content-fitting path, #4720)', () => {
    // `androidContentSized` drops the `%` detents on Android and hosts the form
    // in a `matchContents` RNHostView. A `flex: 1` column resolves to zero there,
    // so the column takes a `maxHeight` ceiling instead — the form measures
    // itself under it, and a keyboard-up long note shrink-scrolls into it.
    // round(844 − 44 − 20) = 780.
    platformMock.OS = 'android';
    const { container } = renderSheet();

    expect(columnStyle(container)).toEqual({ maxHeight: 780 });
  });

  it('renders the fields inside the sheet body, above the pinned action bar', () => {
    const { getByTestId } = renderSheet();

    const body = getByTestId('sheet-body');
    expect(body.querySelector('[data-testid="tick-fields"]')).toBeTruthy();
    expect(body.querySelector('[data-testid="tick-action-bar"]')).toBeNull();
    expect(getByTestId('tick-action-bar')).toBeTruthy();
  });
});
