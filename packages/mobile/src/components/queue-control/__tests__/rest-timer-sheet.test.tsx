// @vitest-environment jsdom
//
// The sheet is where a climber changes the timer, so every case here drives a
// control and then asserts the REAL store / the persisted setting moved. The
// settings mock is stateful for the same reason: a picker that writes a value
// nobody reads back would pass a marker-grep test and fail on a wall.
//
// The rest-length rail is rendered for real (only its chip is mocked), because
// the whole point of replacing the segmented control + stepper was that the
// domain and the selection now live in ONE control — a mocked rail would hide
// exactly the disagreement that used to be the bug.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

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

type LayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };

const harness = vi.hoisted(() => ({
  nowMs: 0,
  sessionId: null as string | null,
  isSharedSession: false,
  inAppBoardConnection: 'connectedByMe',
}));

const haptics = vi.hoisted(() => ({ medium: vi.fn(), selection: vi.fn() }));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ScrollView: forwardRef(function MockScrollView(
    props: { children?: ReactNode; accessibilityLabel?: string; testID?: string },
    ref: unknown,
  ) {
    useImperativeHandle(ref as Parameters<typeof useImperativeHandle>[0], () => ({ scrollTo: vi.fn() }), []);
    return createElement(
      'div',
      { 'data-testid': props.testID, 'data-rail-label': props.accessibilityLabel },
      props.children,
    );
  }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
}));

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
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryLabel: '#666666', tertiaryLabel: '#AAAAAA', separator: '#DDDDDD' },
    brandColors: { error: '#C81E1E', primary: '#7C3AED' },
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
  useIsSharedSession: () => harness.isSharedSession,
}));

vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({ inAppBoardConnection: harness.inAppBoardConnection }),
}));

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } }));

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

// Always renders its children: the cadence controls are what the tests drive,
// and the section's own open/closed state is CollapsibleSection's business
// (covered by its own specs), not this sheet's.
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    persistKey,
    children,
  }: {
    title: string;
    summary?: string | null;
    persistKey?: string;
    children?: ReactNode;
  }) =>
    createElement(
      'section',
      { 'data-collapsible': title, 'data-summary': summary ?? '', 'data-persist-key': persistKey ?? '' },
      children,
    ),
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

// The chip's own painting is GradeChip's business; here it only has to report
// what the rail handed it.
vi.mock('../../tick/TickChip', () => ({
  TickChip: ({
    label,
    tone,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    label: string;
    tone?: string;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    onLayout?: (event: LayoutEvent) => void;
  }) =>
    createElement(
      'button',
      {
        'data-chip': label,
        'data-a11y-label': accessibilityLabel,
        'data-tone': tone ?? 'neutral',
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
        onClick: onPress,
      },
      label,
    ),
}));

import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { REST_LENGTH_RAIL_SECONDS } from '../rest-length-rail.logic';
import { RestTimerSheet } from '../RestTimerSheet';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');
const PAUSE_BUTTON = '[data-button="mobile.restTimer.pause"]';
const RESET_BUTTON = '[data-button="mobile.restTimer.reset"]';
const AUTO_ADVANCE_ROW = '[data-switch="mobile.restTimer.autoAdvance"]';

function renderSheet(onClose = vi.fn()) {
  return { onClose, ...render(<RestTimerSheet visible onClose={onClose} />) };
}

/** Leaves the `waiting` phase: `afterTick` has no anchor until a climb lands. */
function logFirstTick() {
  noteRestTimerTick(new Date(NOW_MS).toISOString(), 'afterTick', NOW_MS);
}

function chipLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-chip]')].map((chip) => chip.getAttribute('data-chip') ?? '');
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

  it('renders one chip per rest length, plus Off, in one notation', () => {
    const { container } = renderSheet();
    const labels = chipLabels(container);

    expect(labels).toHaveLength(REST_LENGTH_RAIL_SECONDS.length + 1);
    expect(labels[0]).toBe('mobile.restTimer.off');
    expect(labels[1]).toBe('0:15');
    expect(labels).toContain('2:00');
    expect(labels[labels.length - 1]).toBe('1:00:00');
    // The old control's second notation ("2m" beside "1:15") is gone.
    expect(labels.some((label) => label.endsWith('m'))).toBe(false);
  });

  it('writes the rest length from a single chip tap and marks it selected', () => {
    const { container } = renderSheet();

    fireEvent.click(container.querySelector('[data-chip="3:00"]') as HTMLElement);

    expect(settingsStore.values.restTimerTargetSeconds).toBe(180);
    expect(container.querySelector('[data-chip="3:00"]')?.getAttribute('data-selected')).toBe('true');
    expect(container.querySelector('[data-chip="2:00"]')?.getAttribute('data-selected')).toBe('false');
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('names each chip by the rest it sets, so a screen reader can jump to one', () => {
    const { container } = renderSheet();

    expect(container.querySelector('[data-chip="1:30"]')?.getAttribute('data-a11y-label')).toBe(
      'mobile.restTimer.setLengthAria:1:30',
    );
    expect(container.querySelector('[data-chip="mobile.restTimer.off"]')?.getAttribute('data-a11y-label')).toBe(
      'mobile.restTimer.offAria',
    );
  });

  it('turns the rest length off from the head chip', () => {
    const { container } = renderSheet();

    fireEvent.click(container.querySelector('[data-chip="mobile.restTimer.off"]') as HTMLElement);

    expect(settingsStore.values.restTimerTargetSeconds).toBeNull();
    expect(container.querySelector('[data-chip="mobile.restTimer.off"]')?.getAttribute('data-selected')).toBe('true');
  });

  it('splices a persisted off-rail rest length in rather than snapping it away', () => {
    // What someone who used the old 15-second stepper could be carrying.
    settingsStore.values.restTimerTargetSeconds = 100;
    const { container } = renderSheet();
    const labels = chipLabels(container);

    expect(labels).toContain('1:40');
    expect(container.querySelector('[data-chip="1:40"]')?.getAttribute('data-selected')).toBe('true');
    // Spliced at its sorted position, between 1:30 and 1:45.
    expect(labels.indexOf('1:40')).toBe(labels.indexOf('1:30') + 1);
    expect(labels[labels.indexOf('1:40') + 1]).toBe('1:45');
    // And nothing rewrote the setting behind the climber's back.
    expect(settingsStore.values.restTimerTargetSeconds).toBe(100);
  });

  it('folds cadence away behind a collapsible that remembers its state', () => {
    const { container } = renderSheet();
    const section = container.querySelector('[data-collapsible="mobile.restTimer.modeLabel"]') as HTMLElement;

    expect(section.getAttribute('data-persist-key')).toBe('restTimer.cadence');
    expect(section.getAttribute('data-summary')).toBe('mobile.restTimer.modeAfterTick');
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

    fireEvent.click(container.querySelector('[data-chip="1:00"]') as HTMLElement);

    expect(settingsStore.values.restTimerTargetSeconds).toBe(60);
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
