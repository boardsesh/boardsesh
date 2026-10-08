// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, useState, type ReactNode, type Ref } from 'react';

// LogAscentSheet wraps `onClose` in a `handleClose` that fires
// `Quick Tick Dismissed` unless the just-closed tick was actually saved
// (tracked via a `savedRef` it hands to useQuickTickForm). Three paths all end
// up calling `handleClose` today: the header's close button, native
// pan-down/backdrop (simulated here through the mocked `BottomSheetModal`'s
// `onChange`), and a successful save (simulated through the stubbed form hook).
//
// The sheet chrome is ModalSheet now, so the #3330 detent bound is re-derived
// through it: the column-bearing view is ModalSheet's chrome column, and the
// detent tests below assert its height at each snap point exactly as they used
// to assert the hand-rolled column's. The keyboard tests drive that column's and
// the action bar's bottom padding through the mocked Keyboard events.

// Mutable so a test can flip the platform; reset in beforeEach. The iOS branch
// is the one that pins a numeric column height (useSheetColumnStyle).
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', Version: '26.1' as string }));
type KeyboardListener = (event: {
  endCoordinates?: { height: number; screenY: number; width: number };
  duration?: number;
}) => void;
const keyboardListeners = vi.hoisted(() => new Map<string, KeyboardListener>());
const sheetControls = vi.hoisted(() => ({ snapToIndex: vi.fn() }));

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
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      keyboardListeners.set(eventName, listener);
      return { remove: () => keyboardListeners.delete(eventName) };
    },
    isVisible: () => false,
    metrics: () => undefined,
  },
  LayoutAnimation: { configureNext: vi.fn() },
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
        createElement('button', {
          key: 'collapse',
          'data-testid': 'simulate-collapse',
          onClick: () => onChange?.(0),
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
    handle: { present: vi.fn(), dismiss: vi.fn(), close: vi.fn(), snapToIndex: sheetControls.snapToIndex },
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', secondaryLabel: '#888', separator: '#ccc', secondaryBackground: '#fff' },
    sheet: { handleStyle: {} },
    sheetSurface: '#181225',
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticMedium: vi.fn(), hapticSelection: vi.fn() }));
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
      note,
    }: {
      primary: { title: string; onPress: () => void; accessibilityLabel?: string; disabled?: boolean };
      secondary?: { title: string; onPress: () => void; accessibilityLabel?: string };
      error?: string | null;
      note?: ReactNode;
    }) =>
      createElement(
        'div',
        { 'data-testid': 'tick-action-bar', 'data-error': error ?? '' },
        note,
        createElement('button', {
          key: 'primary',
          'data-testid': 'simulate-save-success',
          'data-label': primary.accessibilityLabel,
          'data-title': primary.title,
          'data-disabled': String(primary.disabled ?? false),
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
    TickNoteField: ({
      value,
      onChangeText,
      compact,
      onFocus,
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (next: string) => void;
      compact?: boolean;
      onFocus?: () => void;
      accessibilityLabel: string;
    }) =>
      createElement('textarea', {
        'data-testid': 'tick-note',
        'data-compact': String(compact),
        'aria-label': accessibilityLabel,
        value,
        onFocus,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.currentTarget.value),
      }),
  };
});

// Stub the form hook: `onSave` mirrors the real success path (flip savedRef,
// then call onDismiss) so the "save, don't double-count as a dismiss" branch can
// be driven without the mutation, the logbook and the analytics behind it.
vi.mock('../play-drawer/use-quick-tick-form', () => ({
  useQuickTickForm: (input: {
    climbUuid: string;
    baseAscensionistCount: number;
    boardName: string;
    onDismiss: () => void;
    savedRef?: { current: boolean };
  }) => {
    formInput.current = input;
    const [comment, setComment] = useState('');
    return {
      tickState: { quality: null, difficulty: undefined, attemptCount: 1 },
      comment,
      climbedAt: new Date('2025-06-01T08:00:00.000Z'),
      maximumClimbedAtDate: new Date('2025-06-01T08:00:00.000Z'),
      grades: [],
      consensusDifficultyId: undefined,
      firstAscent: input.boardName === 'spray' && input.baseAscensionistCount === 0,
      saveBlockedByGrade: input.boardName === 'spray' && input.baseAscensionistCount === 0,
      resolvedGradeName: undefined,
      ascentType: 'send',
      saveLabel: 'playView.tickBar.sendSaveLabel',
      isPending: false,
      lastError: null,
      onQualitySelect: vi.fn(),
      onGradeSelect: vi.fn(),
      onTriesSelect: vi.fn(),
      onCommentChange: setComment,
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
  QuickTickBar: ({ showNote }: { showNote?: boolean }) =>
    createElement('div', { 'data-testid': 'tick-fields', 'data-show-note': String(showNote) }),
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
// action bar are laid out inside. Owned by ModalSheet now, addressed by testID
// rather than by position. Flattened: with the keyboard up it is a style array.
function flattenStyle(style: unknown): Record<string, number> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return (style ?? {}) as Record<string, number>;
}
function columnStyle(container: HTMLElement): Record<string, number> {
  const column = container.querySelector('[data-testid="sheet-chrome-column"]');
  if (!column) throw new Error('sheet column not rendered');
  return flattenStyle(JSON.parse(column.getAttribute('data-style') ?? 'null'));
}
// The pinned footer bar ModalSheet wraps around the stubbed TickActionBar.
function footerPaddingBottom(container: HTMLElement): number | undefined {
  const bar = container.querySelector('[data-testid="tick-action-bar"]');
  return flattenStyle(JSON.parse(bar?.parentElement?.getAttribute('data-style') ?? 'null')).paddingBottom;
}

beforeEach(() => {
  keyboardListeners.clear();
  platformMock.OS = 'ios';
  platformMock.Version = '26.1';
  formInput.current = null;
  vi.mocked(track).mockClear();
  sheetControls.snapToIndex.mockClear();
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

  it('says "consensus" only once somebody has sent it (#5960 C7)', () => {
    const { getByTestId, unmount } = renderSheet({ consensusGradeName: 'V2', baseAscensionistCount: 0 });
    expect(getByTestId('tick-header').getAttribute('data-subtitle')).toBe('mobile.tick.angleMeta');
    unmount();

    const sent = renderSheet({ consensusGradeName: 'V2', baseAscensionistCount: 1 });
    expect(sent.getByTestId('tick-header').getAttribute('data-subtitle')).toBe('mobile.tick.consensusMeta');
  });
});

describe('LogAscentSheet first ascent (#5971)', () => {
  it('disables Send while a first-ascent send is missing its grade', () => {
    const { getByTestId } = renderSheet({ boardName: 'spray', baseAscensionistCount: 0 });
    expect(getByTestId('simulate-save-success').getAttribute('data-disabled')).toBe('true');
  });

  it('leaves Send enabled on an ordinary tick', () => {
    const { getByTestId } = renderSheet({ boardName: 'kilter', baseAscensionistCount: 0 });
    expect(getByTestId('simulate-save-success').getAttribute('data-disabled')).toBe('false');
  });
});

// The form is a scroll body with a pinned Attempt/Send row, which only holds
// together if ModalSheet's column is clamped to the detent. On iOS the @expo/ui
// SwiftUI sheet host can propose an unbounded height, so a flex:1 column would
// size to its content: nothing scrolls and the action bar lands off-screen
// (#3330). The window here is 844 with a 44pt top inset, so the iOS 26 base is
// 844 − 44 − 24 = 776; a detent is round(776 × fraction) − 20pt of chrome.
describe('LogAscentSheet detent bound', () => {
  it('pins the column to the 50% medium detent on iOS instead of letting it flex to content', () => {
    const { container } = renderSheet();

    expect(columnStyle(container)).toEqual({ height: 368 });
  });

  it('grows the column when the sheet settles on the taller 90% large detent', () => {
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));

    expect(columnStyle(container)).toEqual({ height: 678 });
  });

  it('drops back to the shortest detent on close, so the next present starts bounded', () => {
    // PlayDrawer keeps this host mounted, so a stale 90% height would survive
    // into the next present and push the action bar past the first detent.
    const { container, getByTestId } = renderSheet();

    fireEvent.click(getByTestId('simulate-expand'));
    fireEvent.click(getByTestId('simulate-pandown'));

    expect(columnStyle(container)).toEqual({ height: 368 });
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

describe('LogAscentSheet pinned comment', () => {
  it('shows a compact comment outside the scrolling body at the medium detent', () => {
    const { getByTestId } = renderSheet();
    const note = getByTestId('tick-note');
    expect(note.getAttribute('data-compact')).toBe('true');
    expect(getByTestId('sheet-body').contains(note)).toBe(false);
    expect(getByTestId('tick-action-bar').contains(note)).toBe(true);
    expect(getByTestId('tick-action-bar').firstElementChild).toBe(note);
    expect(getByTestId('tick-fields').getAttribute('data-show-note')).toBe('false');
  });

  it('keeps the typed comment and focused input while expanding and collapsing', () => {
    const { getByTestId, onClose } = renderSheet();
    const note = getByTestId('tick-note') as HTMLTextAreaElement;
    act(() => note.focus());
    fireEvent.change(note, { target: { value: 'Left heel\nThen match' } });
    fireEvent.click(getByTestId('simulate-expand'));
    expect(getByTestId('tick-note')).toBe(note);
    expect(note.getAttribute('data-compact')).toBe('false');
    expect(document.activeElement).toBe(note);
    expect(note.value).toBe('Left heel\nThen match');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByTestId('simulate-collapse'));
    expect(getByTestId('tick-note')).toBe(note);
    expect(note.getAttribute('data-compact')).toBe('true');
    expect(note.value).toBe('Left heel\nThen match');
  });

  it('requests the large detent on comment focus through the managed handle', () => {
    const { getByTestId } = renderSheet();
    fireEvent.focus(getByTestId('tick-note'));
    expect(sheetControls.snapToIndex).toHaveBeenCalledWith(1);
  });

  it('does not snap an already expanded or Android content-sized sheet', () => {
    const expanded = renderSheet();
    fireEvent.click(expanded.getByTestId('simulate-expand'));
    fireEvent.focus(expanded.getByTestId('tick-note'));
    expect(sheetControls.snapToIndex).not.toHaveBeenCalled();
    expanded.unmount();

    platformMock.OS = 'android';
    const android = renderSheet();
    expect(android.getByTestId('tick-note').getAttribute('data-compact')).toBe('false');
    fireEvent.focus(android.getByTestId('tick-note'));
    expect(sheetControls.snapToIndex).not.toHaveBeenCalled();
  });

  it('keeps expanded sizing while dismissing, then resets on a fresh present', () => {
    const { getByTestId, rerender } = renderSheet();
    fireEvent.click(getByTestId('simulate-expand'));
    fireEvent.click(getByTestId('simulate-pandown'));
    expect(getByTestId('tick-note').getAttribute('data-compact')).toBe('false');
    const props = {
      onClose: vi.fn(),
      climbUuid: 'climb-1',
      boardName: 'kilter',
      angle: 40,
      isMirror: false,
      isBenchmark: false,
      baseAscensionistCount: 10,
    };
    rerender(createElement(LogAscentSheet, { ...props, visible: false }));
    rerender(createElement(LogAscentSheet, { ...props, visible: true }));
    expect(getByTestId('tick-note').getAttribute('data-compact')).toBe('true');
  });
});

// The user-reported bug: typing a note left the Attempt / Save bar half under
// the keyboard. The column must pad by the whole keyboard and the bar must drop
// its window inset (spacing is mocked to 0 here, so the bar's padding IS the
// inset it still owes).
describe('LogAscentSheet keyboard', () => {
  it('lifts the action bar fully above the iOS keyboard, then settles back on the inset', () => {
    const { container, getByTestId } = renderSheet();
    fireEvent.click(getByTestId('simulate-expand'));
    expect(footerPaddingBottom(container)).toBe(34);

    act(() =>
      keyboardListeners.get('keyboardWillChangeFrame')?.({
        endCoordinates: { height: 336, screenY: 508, width: 390 },
        duration: 250,
      }),
    );
    expect(columnStyle(container)).toEqual({ height: 678, paddingBottom: 336 });
    expect(footerPaddingBottom(container)).toBe(0);

    act(() =>
      keyboardListeners.get('keyboardWillHide')?.({
        endCoordinates: { height: 336, screenY: 844, width: 390 },
        duration: 250,
      }),
    );
    expect(columnStyle(container)).toEqual({ height: 678 });
    expect(footerPaddingBottom(container)).toBe(34);
  });

  it('does not listen for the keyboard while the sheet is closed', () => {
    renderSheet({ visible: false });
    expect(keyboardListeners.size).toBe(0);
  });

  it('pads by keyboard + navigation bar on Android, where the IME height leaves the bar out', () => {
    platformMock.OS = 'android';
    const { container } = renderSheet();

    act(() =>
      keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280, screenY: 564, width: 390 } }),
    );
    expect(columnStyle(container)).toEqual({ maxHeight: 780, paddingBottom: 280 + 34 });
    expect(footerPaddingBottom(container)).toBe(0);

    act(() => keyboardListeners.get('keyboardDidHide')?.({}));
    expect(columnStyle(container)).toEqual({ maxHeight: 780 });
    expect(footerPaddingBottom(container)).toBe(34);
  });
});
// This suite exercises the existing flow before the server privacy rollout.
vi.mock('../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../privacy/PublicationAudiencePicker', () => ({
  PublicationAudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/ContentAudienceControl', () => ({
  ContentAudienceControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/AudiencePicker', () => ({
  AudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));
