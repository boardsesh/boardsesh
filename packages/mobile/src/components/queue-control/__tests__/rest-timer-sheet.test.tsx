// @vitest-environment jsdom
//
// The sheet is where a climber changes the timer, so every case here drives a
// control and then asserts the REAL store / the persisted setting moved. The
// settings mock is stateful for the same reason: a picker that writes a value
// nobody reads back would pass a marker-grep test and fail on a wall.
//
// The rest-length pill and the slider it reveals are rendered for real (only
// reanimated and gesture-handler are stubbed), because the whole point of the
// control is that the value, the tap ladder and the slider are ONE thing — a
// mocked picker would hide exactly the disagreement that used to be the bug.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SegmentedProps = {
  options: { key: string; label: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
  accessibilityLabel?: string;
};

type SwitchProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
};

type ButtonProps = {
  title: string;
  onPress: () => void;
  icon?: string;
  disabled?: boolean;
  variant?: string;
};

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityValue?: { text?: string; min?: number; max?: number; now?: number };
  accessibilityActions?: readonly { name: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

type PressableProps = {
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { expanded?: boolean };
};

const harness = vi.hoisted(() => ({
  nowMs: 0,
  sessionId: null as string | null,
  isSharedSession: false,
  inAppBoardConnection: 'connectedByMe',
}));

const haptics = vi.hoisted(() => ({ medium: vi.fn(), selection: vi.fn(), light: vi.fn() }));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  // The slider's adjustable node is a View, and its increment / decrement
  // actions are the only way a VoiceOver user — or a test, which has no thumb
  // either — moves it. A click stands in for increment, a right-click for
  // decrement.
  View: ({
    children,
    testID,
    accessibilityRole,
    accessibilityLabel,
    accessibilityValue,
    accessibilityActions,
    onAccessibilityAction,
  }: ViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-a11y-role': accessibilityRole,
        'data-a11y-label': accessibilityLabel,
        'data-a11y-value': accessibilityValue?.text,
        'data-a11y-min': accessibilityValue?.min,
        'data-a11y-max': accessibilityValue?.max,
        'data-a11y-actions': accessibilityActions?.map((action) => action.name).join(','),
        onClick: onAccessibilityAction
          ? () => onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
          : undefined,
        onContextMenu: onAccessibilityAction
          ? () => onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } })
          : undefined,
      },
      children,
    ),
  Pressable: ({
    children,
    testID,
    onPress,
    onLongPress,
    delayLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  }: PressableProps) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'data-a11y-label': accessibilityLabel,
        'data-a11y-hint': accessibilityHint,
        'data-expanded': accessibilityState?.expanded == null ? undefined : String(accessibilityState.expanded),
        'data-delay-long-press': delayLongPress,
        onClick: onPress,
        // jsdom has no long press; a right-click stands in for one.
        onContextMenu: onLongPress,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-reanimated', () => {
  const AnimatedView = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const fade = { duration: () => ({}) };
  return {
    default: {
      View: AnimatedView,
      // The press-scale and thumb-grow springs these drive are UI-thread
      // decoration; what matters here is that the control renders and commits.
      createAnimatedComponent: <P,>(Component: (props: P) => ReactNode) => Component,
    },
    FadeIn: fade,
    FadeOut: fade,
    useAnimatedStyle: () => ({}),
    useSharedValue: (initial: number) => ({ value: initial, get: () => initial, set: () => {} }),
    withSpring: (value: number) => value,
    runOnJS: <A extends unknown[]>(fn: (...args: A) => void) => fn,
  };
});

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const gesture = new Proxy(chainable, { get: () => () => gesture });
  return {
    Gesture: { Pan: () => gesture, Tap: () => gesture, Race: () => gesture },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));

vi.mock('../../../settings', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useSetting: (key: string) => {
      const [, forceRender] = useReducer((count: number) => count + 1, 0);
      useEffect(() => {
        settingsStore.listeners.add(forceRender);
        return () => {
          settingsStore.listeners.delete(forceRender);
        };
      }, []);
      const write = (next: unknown) => {
        settingsStore.values[key] = next;
        for (const listener of settingsStore.listeners) listener();
      };
      return [settingsStore.values[key], write];
    },
    getSetting: (key: string) => settingsStore.values[key],
  };
});

vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));

vi.mock('../../../lib/haptics', () => ({
  hapticMedium: haptics.medium,
  hapticSelection: haptics.selection,
  hapticLight: haptics.light,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#111111',
      secondaryLabel: '#666666',
      tertiaryLabel: '#AAAAAA',
      separator: '#DDDDDD',
      fill: '#78788033',
    },
    brandColors: { error: '#C81E1E', primary: '#7C3AED' },
  }),
}));

vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} }, timing: { instant: 50, fast: 150 } }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
  useIsSharedSession: () => harness.isSharedSession,
}));

vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({ inAppBoardConnection: harness.inAppBoardConnection }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { full: 9999 },
}));

vi.mock('../RestTimerPill', () => ({
  RestTimerHeroClock: () => createElement('span', { 'data-testid': 'sheet-hero-clock' }),
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', { 'data-testid': 'sheet' }, children) : null,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress, icon, disabled, variant }: ButtonProps) =>
    createElement(
      'button',
      {
        'data-button': title,
        'data-icon': icon ?? '',
        'data-variant': variant ?? '',
        'data-disabled': String(Boolean(disabled)),
        onClick: () => {
          if (!disabled) onPress();
        },
      },
      title,
    ),
}));

vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, description, value, onValueChange, disabled }: SwitchProps) =>
    createElement('button', {
      'data-switch': label,
      'data-value': String(value),
      'data-disabled': String(Boolean(disabled)),
      'data-description': description ?? '',
      onClick: () => {
        if (!disabled) onValueChange(!value);
      },
    }),
}));

vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', { 'data-section': title }, title),
}));

vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect, accessibilityLabel }: SegmentedProps) =>
    createElement(
      'div',
      { 'data-segmented': accessibilityLabel ?? '' },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-segment': `${accessibilityLabel}:${option.key}`,
            'data-selected': String(option.key === selectedKey),
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../tick/TickDestructiveRow', () => ({
  TickDestructiveRow: ({ label, icon, onPress }: { label: string; icon?: string; onPress: () => void }) =>
    createElement('button', { 'data-destructive': label, 'data-icon': icon ?? 'delete', onClick: onPress }, label),
}));

import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { RestTimerSheet } from '../RestTimerSheet';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');
const PAUSE_BUTTON = '[data-button="mobile.restTimer.pause"]';
const RESET_BUTTON = '[data-button="mobile.restTimer.reset"]';
const AUTO_ADVANCE_ROW = '[data-switch="mobile.restTimer.autoAdvance"]';
const LENGTH_PILL = '[data-testid="rest-length-pill"]';
const LENGTH_SLIDER = '[data-testid="rest-length-slider"]';

function renderSheet(onClose = vi.fn()) {
  return { onClose, ...render(<RestTimerSheet visible onClose={onClose} />) };
}

/** Leaves the `waiting` phase: `afterTick` has no anchor until a climb lands. */
function logFirstTick() {
  noteRestTimerTick(new Date(NOW_MS).toISOString(), 'afterTick', NOW_MS);
}

/** The rest the pill is currently showing. */
function pillLabel(container: HTMLElement): string {
  return container.querySelector(LENGTH_PILL)?.textContent ?? '';
}

/** Long-press: the only way to the fine slider, here and on a wall. */
function holdPill(container: HTMLElement) {
  fireEvent.contextMenu(container.querySelector(LENGTH_PILL) as HTMLElement);
}

describe('RestTimerSheet', () => {
  beforeEach(() => {
    harness.nowMs = NOW_MS;
    harness.sessionId = 'session-1';
    harness.isSharedSession = false;
    harness.inAppBoardConnection = 'connectedByMe';
    haptics.medium.mockClear();
    haptics.selection.mockClear();
    settingsStore.values = {
      restTimerTargetSeconds: 120,
      restTimerMode: 'afterTick',
      restTimerAutoAdvance: false,
    };
    settingsStore.listeners.clear();
    armRestTimer('afterTick', NOW_MS, 'session-1');
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
  });

  it('shows the live hero clock so the sheet is not a dead settings page', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('sheet-hero-clock')).not.toBeNull();
  });

  it('pauses and resumes the real timer from the transport, with a haptic each way', () => {
    logFirstTick();
    const { container } = renderSheet();

    fireEvent.click(container.querySelector(PAUSE_BUTTON) as HTMLElement);
    expect(getRestTimerState().isRunning).toBe(false);

    fireEvent.click(container.querySelector('[data-button="mobile.restTimer.resume"]') as HTMLElement);
    expect(getRestTimerState().isRunning).toBe(true);
    expect(haptics.medium).toHaveBeenCalledTimes(2);
  });

  it('resets the cycle from the tonal Reset, which is a button and not a link', () => {
    logFirstTick();
    const beforeCycleId = getRestTimerState().cycleId;
    const { container } = renderSheet();

    const reset = container.querySelector(RESET_BUTTON) as HTMLElement;
    expect(reset.getAttribute('data-variant')).toBe('tonal');
    fireEvent.click(reset);
    expect(getRestTimerState().cycleId).toBeGreaterThan(beforeCycleId);
  });

  it('keeps the transport mounted but DISABLED while waiting for the first tick', () => {
    // `afterTick` before a climb: armed, nominally running, but with no anchor
    // there is nothing to pause and nothing to reset.
    const { container } = renderSheet();
    const pause = container.querySelector(PAUSE_BUTTON) as HTMLElement;
    const reset = container.querySelector(RESET_BUTTON) as HTMLElement;

    expect(pause.getAttribute('data-disabled')).toBe('true');
    expect(reset.getAttribute('data-disabled')).toBe('true');

    fireEvent.click(pause);
    fireEvent.click(reset);
    expect(getRestTimerState().isRunning).toBe(true);
  });

  it('shows the rest on ONE pill, in one notation, with no rail to scroll', () => {
    const { container } = renderSheet();

    expect(pillLabel(container)).toBe('2:00');
    // The old control's second notation ("2m" beside "1:15") is gone, and so is
    // the 27-chip rail that hid 2:00 and 3:00 behind a horizontal scroll.
    expect(container.querySelectorAll(LENGTH_PILL)).toHaveLength(1);
  });

  it('steps the rest 30 seconds a tap, and says so before you tap it', () => {
    const { container } = renderSheet();
    const pill = container.querySelector(LENGTH_PILL) as HTMLElement;

    expect(pill.getAttribute('data-a11y-label')).toBe('mobile.restTimer.lengthPillAria:2:00');
    expect(pill.getAttribute('data-a11y-hint')).toBe('mobile.restTimer.lengthPillHint');

    fireEvent.click(pill);

    expect(settingsStore.values.restTimerTargetSeconds).toBe(150);
    expect(pillLabel(container)).toBe('2:30');
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('wraps to Off past the top of the ladder, so Off is one tap and not a scroll', () => {
    settingsStore.values.restTimerTargetSeconds = 600;
    const { container } = renderSheet();

    fireEvent.click(container.querySelector(LENGTH_PILL) as HTMLElement);

    expect(settingsStore.values.restTimerTargetSeconds).toBeNull();
    expect(pillLabel(container)).toBe('mobile.restTimer.off');
  });

  it('honours a persisted off-ladder rest, and never rewrites it on mount', () => {
    // What someone who used the old 15-second stepper could be carrying.
    settingsStore.values.restTimerTargetSeconds = 100;
    const { container } = renderSheet();

    expect(pillLabel(container)).toBe('1:40');
    expect(settingsStore.values.restTimerTargetSeconds).toBe(100);

    // The first tap puts them back on the ladder rather than carrying the odd
    // offset up it.
    fireEvent.click(container.querySelector(LENGTH_PILL) as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(120);
  });

  it('reveals the fine slider on a long press, and folds it away again', () => {
    const { container } = renderSheet();

    expect(container.querySelector(LENGTH_SLIDER)).toBeNull();
    expect(container.querySelector(LENGTH_PILL)?.getAttribute('data-delay-long-press')).toBe('300');

    holdPill(container);
    expect(container.querySelector(LENGTH_SLIDER)).not.toBeNull();
    expect(container.querySelector(LENGTH_PILL)?.getAttribute('data-expanded')).toBe('true');

    holdPill(container);
    expect(container.querySelector(LENGTH_SLIDER)).toBeNull();
    expect(container.querySelector(LENGTH_PILL)?.getAttribute('data-expanded')).toBe('false');
  });

  it('publishes the slider as one adjustable node over the whole duration range', () => {
    const { container } = renderSheet();
    holdPill(container);
    const slider = container.querySelector(LENGTH_SLIDER) as HTMLElement;

    expect(slider.getAttribute('data-a11y-role')).toBe('adjustable');
    expect(slider.getAttribute('data-a11y-label')).toBe('mobile.restTimer.targetAria');
    expect(slider.getAttribute('data-a11y-value')).toBe('2:00');
    expect(slider.getAttribute('data-a11y-min')).toBe('15');
    expect(slider.getAttribute('data-a11y-max')).toBe('3600');
    expect(slider.getAttribute('data-a11y-actions')).toBe('increment,decrement');
  });

  it('sets a rest without a gesture, for the climber driving it by voice', () => {
    // A pan is invisible to VoiceOver, so increment / decrement are the only way
    // in — and from Off they have to reach a real duration, not stay at Off.
    settingsStore.values.restTimerTargetSeconds = null;
    const { container } = renderSheet();
    holdPill(container);

    fireEvent.click(container.querySelector(LENGTH_SLIDER) as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(90);
    expect(pillLabel(container)).toBe('1:30');

    fireEvent.contextMenu(container.querySelector(LENGTH_SLIDER) as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(60);
  });

  it('puts cadence inline — a binary with one other option is not a disclosure', () => {
    const { container } = renderSheet();

    expect(container.querySelector('[data-collapsible]')).toBeNull();
    expect(container.querySelector('[data-segmented="mobile.restTimer.modeAria"]')).not.toBeNull();
    expect(container.querySelector('[data-section="mobile.restTimer.modeLabel"]')).not.toBeNull();
    // Both options AND the hint for the live one are readable without a tap.
    expect(container.querySelector('[data-segment="mobile.restTimer.modeAria:onTheMinute"]')).not.toBeNull();
    expect(container.textContent).toContain('mobile.restTimer.modeAfterTickHint');
  });

  it('re-arms cleanly when the cadence changes, rather than leaving a half-converted anchor', () => {
    const { container } = renderSheet();
    expect(getRestTimerState().anchorMs).toBeNull();

    harness.nowMs = NOW_MS + 5_000;
    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.modeAria:onTheMinute"]') as HTMLElement);

    expect(settingsStore.values.restTimerMode).toBe('onTheMinute');
    // `onTheMinute` anchors on the spot; `afterTick` had none. A re-arm is the
    // only thing that produces that.
    expect(getRestTimerState().anchorMs).toBe(NOW_MS + 5_000);
    expect(getRestTimerState().armedForSessionId).toBe('session-1');
  });

  it('lets the climber driving the wall arm auto-advance', () => {
    const { container } = renderSheet();
    const row = container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement;

    expect(row.getAttribute('data-disabled')).toBe('false');
    expect(row.getAttribute('data-description')).toBe('mobile.restTimer.autoAdvanceHint');

    fireEvent.click(row);
    expect(settingsStore.values.restTimerAutoAdvance).toBe(true);
  });

  it('disables auto-advance with the rest length Off, because there is no deadline to fire on', () => {
    settingsStore.values.restTimerTargetSeconds = null;
    const { container } = renderSheet();
    const row = container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement;

    expect(row.getAttribute('data-disabled')).toBe('true');
    expect(row.getAttribute('data-description')).toBe('mobile.restTimer.autoAdvanceNeedsLength');

    fireEvent.click(row);
    expect(settingsStore.values.restTimerAutoAdvance).toBe(false);
  });

  it('re-enables auto-advance as soon as a rest length is picked', () => {
    settingsStore.values.restTimerTargetSeconds = null;
    const { container } = renderSheet();

    fireEvent.click(container.querySelector(LENGTH_PILL) as HTMLElement);

    expect(settingsStore.values.restTimerTargetSeconds).toBe(30);
    expect(container.querySelector(AUTO_ADVANCE_ROW)?.getAttribute('data-disabled')).toBe('false');
  });

  it('disables auto-advance for a crew passenger, and says why', () => {
    harness.isSharedSession = true;
    harness.inAppBoardConnection = 'connectedByPeer';
    const { container } = renderSheet();
    const row = container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement;

    expect(row.getAttribute('data-disabled')).toBe('true');
    expect(row.getAttribute('data-description')).toBe('mobile.restTimer.autoAdvanceBlocked');

    fireEvent.click(row);
    expect(settingsStore.values.restTimerAutoAdvance).toBe(false);
  });

  it('keeps the crew reason ahead of the needs-a-length one, so a passenger is not sent round a loop', () => {
    harness.isSharedSession = true;
    harness.inAppBoardConnection = 'connectedByPeer';
    settingsStore.values.restTimerTargetSeconds = null;
    const { container } = renderSheet();

    expect(container.querySelector(AUTO_ADVANCE_ROW)?.getAttribute('data-description')).toBe(
      'mobile.restTimer.autoAdvanceBlocked',
    );
  });

  it('turns the timer off from the destructive row — with a STOP glyph, not the pill’s clock', () => {
    const onClose = vi.fn();
    const { container } = renderSheet(onClose);

    const turnOff = container.querySelector('[data-destructive="mobile.restTimer.turnOff"]') as HTMLElement;
    expect(turnOff.getAttribute('data-icon')).toBe('end.session');

    fireEvent.click(turnOff);
    expect(getRestTimerState().armed).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
