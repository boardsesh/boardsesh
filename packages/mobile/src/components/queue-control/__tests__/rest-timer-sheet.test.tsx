// @vitest-environment jsdom
//
// The sheet is where a climber changes the timer, so every case here drives a
// control and then asserts the REAL store / the persisted setting moved. The
// settings mock is stateful for the same reason: a picker that writes a value
// nobody reads back would pass a marker-grep test and fail on a wall.
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

type StepperProps = { label: string; value: number; min: number; max: number; onChange: (next: number) => void };

const harness = vi.hoisted(() => ({
  nowMs: 0,
  sessionId: null as string | null,
  isSharedSession: false,
  inAppBoardConnection: 'connectedByMe',
}));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
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

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryLabel: '#666666', tertiaryLabel: '#AAAAAA' },
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

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

vi.mock('../RestTimerPill', () => ({
  RestTimerClock: () => createElement('span', { 'data-testid': 'sheet-clock' }),
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', { 'data-testid': 'sheet' }, children) : null,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color ?? '' }),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }, title),
}));

vi.mock('../../ListRow', () => ({
  ListRow: ({ title, onPress, leading }: { title: string; onPress?: () => void; leading?: ReactNode }) =>
    createElement('button', { 'data-listrow': title, onClick: onPress }, leading, title),
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

// Mirrors the real Stepper: ±1, clamped to [min, max]. That is exactly what the
// sheet's 15-second snapping has to cope with, so the mock must not "help".
vi.mock('../../Stepper', () => ({
  Stepper: ({ label, value, min, max, onChange }: StepperProps) =>
    createElement(
      'div',
      { 'data-stepper': label, 'data-value': String(value), 'data-min': String(min), 'data-max': String(max) },
      createElement('button', { 'data-stepper-inc': 'true', onClick: () => onChange(Math.min(max, value + 1)) }),
      createElement('button', { 'data-stepper-dec': 'true', onClick: () => onChange(Math.max(min, value - 1)) }),
    ),
}));

import { armRestTimer, getRestTimerState, resetRestTimerStoreForTests } from '../../../lib/rest-timer-store';
import { RestTimerSheet } from '../RestTimerSheet';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');

function renderSheet(onClose = vi.fn()) {
  return { onClose, ...render(<RestTimerSheet visible onClose={onClose} />) };
}

describe('RestTimerSheet', () => {
  beforeEach(() => {
    harness.nowMs = NOW_MS;
    harness.sessionId = 'session-1';
    harness.isSharedSession = false;
    harness.inAppBoardConnection = 'connectedByMe';
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

  it('shows the live clock so the sheet is not a dead settings page', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('sheet-clock')).not.toBeNull();
  });

  it('pauses and resumes the real timer from the primary button', () => {
    const { getByText } = renderSheet();

    fireEvent.click(getByText('mobile.restTimer.pause'));
    expect(getRestTimerState().isRunning).toBe(false);

    fireEvent.click(getByText('mobile.restTimer.resume'));
    expect(getRestTimerState().isRunning).toBe(true);
  });

  it('resets the cycle from the text button', () => {
    const beforeCycleId = getRestTimerState().cycleId;
    const { getByText } = renderSheet();

    fireEvent.click(getByText('mobile.restTimer.reset'));
    expect(getRestTimerState().cycleId).toBeGreaterThan(beforeCycleId);
  });

  it('writes a preset rest length and marks it selected', () => {
    const { container } = renderSheet();

    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.targetAria:180"]') as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(180);
    expect(
      container.querySelector('[data-segment="mobile.restTimer.targetAria:180"]')?.getAttribute('data-selected'),
    ).toBe('true');
  });

  it('turns the rest length off', () => {
    const { container } = renderSheet();

    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.targetAria:off"]') as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBeNull();
  });

  it('reveals a 15-second stepper behind Custom', () => {
    const { container } = renderSheet();
    expect(container.querySelector('[data-stepper]')).toBeNull();

    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.targetAria:custom"]') as HTMLElement);
    const stepper = container.querySelector('[data-stepper]');
    expect(stepper?.getAttribute('data-value')).toBe('120');
    expect(stepper?.getAttribute('data-min')).toBe('15');
    expect(stepper?.getAttribute('data-max')).toBe('3600');

    fireEvent.click(container.querySelector('[data-stepper-inc]') as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(135);

    fireEvent.click(container.querySelector('[data-stepper-dec]') as HTMLElement);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(120);
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
    const row = container.querySelector('[data-switch="mobile.restTimer.autoAdvance"]') as HTMLElement;

    expect(row.getAttribute('data-disabled')).toBe('false');
    expect(row.getAttribute('data-description')).toBe('mobile.restTimer.autoAdvanceHint');

    fireEvent.click(row);
    expect(settingsStore.values.restTimerAutoAdvance).toBe(true);
  });

  it('disables auto-advance for a crew passenger, and says why', () => {
    harness.isSharedSession = true;
    harness.inAppBoardConnection = 'connectedByPeer';
    const { container } = renderSheet();
    const row = container.querySelector('[data-switch="mobile.restTimer.autoAdvance"]') as HTMLElement;

    expect(row.getAttribute('data-disabled')).toBe('true');
    expect(row.getAttribute('data-description')).toBe('mobile.restTimer.autoAdvanceBlocked');

    fireEvent.click(row);
    expect(settingsStore.values.restTimerAutoAdvance).toBe(false);
  });

  it('turns the timer off from the pinned destructive row, and closes', () => {
    const onClose = vi.fn();
    const { container } = renderSheet(onClose);

    const turnOff = container.querySelector('[data-listrow="mobile.restTimer.turnOff"]') as HTMLElement;
    expect(turnOff.querySelector('[data-icon="clock"]')?.getAttribute('data-color')).toBe('#C81E1E');

    fireEvent.click(turnOff);
    expect(getRestTimerState().armed).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
