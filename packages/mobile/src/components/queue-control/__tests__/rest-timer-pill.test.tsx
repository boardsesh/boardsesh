// @vitest-environment jsdom
//
// The pill is the only place the rest timer is visible, so these are behavioural:
// the REAL store is armed/ticked/paused and the rendered digits + colour are
// asserted. The clock is mocked so "a second passed" is something the test says,
// not something it waits for.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type PressableProps = {
  children?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  testID?: string;
};

const harness = vi.hoisted(() => ({
  nowMs: 0,
  settings: {} as Record<string, unknown>,
  reduceMotion: false,
  pressable: null as PressableProps | null,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryLabel: '#666666', tertiaryLabel: '#AAAAAA' },
    brandColors: { error: '#C81E1E', primary: '#7C3AED' },
  }),
}));

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => harness.reduceMotion }));

vi.mock('../../../settings', () => ({ useSetting: (key: string) => [harness.settings[key], vi.fn()] }));

vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));

vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

vi.mock('../../Text', () => ({
  Text: ({ children, color, testID }: { children?: ReactNode; color?: string; testID?: string }) =>
    createElement('span', { 'data-text': 'true', 'data-color': color ?? '', 'data-testid': testID }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color ?? '' }),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: (props: PressableProps) => {
    harness.pressable = props;
    return createElement(
      'button',
      {
        'data-testid': props.testID,
        'data-role': props.accessibilityRole,
        'data-label': props.accessibilityLabel,
        'data-hint': props.accessibilityHint,
        'data-actions': (props.accessibilityActions ?? []).map((action) => `${action.name}:${action.label}`).join('|'),
        onClick: props.onPress,
      },
      props.children,
    );
  },
}));

vi.mock('../AccessoryBarSurface', () => ({
  AccessoryBarSurface: ({ children, height }: { children?: ReactNode; height: number }) =>
    createElement('div', { 'data-surface': 'true', 'data-height': String(height) }, children),
}));

import { hapticMedium } from '../../../lib/haptics';
import {
  armRestTimer,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  getRestTimerState,
} from '../../../lib/rest-timer-store';
import { RestTimerPill } from '../RestTimerPill';

const START_MS = Date.parse('2026-09-11T10:00:00.000Z');

function advanceSeconds(seconds: number) {
  act(() => {
    harness.nowMs += seconds * 1000;
    vi.advanceTimersByTime(seconds * 1000);
  });
}

/** Arms in `afterTick` and lands a tick at "now", so the pill has an anchor. */
function armWithTick() {
  act(() => {
    armRestTimer('afterTick', harness.nowMs, null);
    noteRestTimerTick(new Date(harness.nowMs).toISOString(), 'afterTick', harness.nowMs);
  });
}

function elapsedText(container: HTMLElement): string {
  return container.querySelector('[data-testid="rest-timer-pill-elapsed"]')?.textContent ?? '';
}

function elapsedColor(container: HTMLElement): string {
  return container.querySelector('[data-testid="rest-timer-pill-elapsed"]')?.getAttribute('data-color') ?? '';
}

describe('RestTimerPill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(hapticMedium).mockClear();
    harness.nowMs = START_MS;
    harness.reduceMotion = false;
    harness.pressable = null;
    harness.settings = { restTimerTargetSeconds: 60, restTimerMode: 'afterTick', restTimerAutoAdvance: false };
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
    vi.useRealTimers();
  });

  it('renders nothing while the timer is disarmed', () => {
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);
    expect(container.querySelector('[data-testid="rest-timer-pill"]')).toBeNull();
  });

  it('shows the target, not a false 0:00, before the first tick lands', () => {
    act(() => armRestTimer('afterTick', harness.nowMs, null));
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    expect(elapsedText(container)).toBe('1m');
    expect(container.querySelector('[data-testid="rest-timer-pill-secondary"]')?.textContent).toBe(
      'mobile.restTimer.waitingForTick',
    );
    expect(elapsedColor(container)).toBe('#AAAAAA');
    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.noTickAria:1m',
    );
  });

  it('counts up once a tick lands, in the plain label colour under the target', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    expect(elapsedText(container)).toBe('0:00');
    advanceSeconds(30);
    expect(elapsedText(container)).toBe('0:30');
    expect(elapsedColor(container)).toBe('#111111');
    expect(container.querySelector('[data-testid="rest-timer-pill-secondary"]')?.textContent).toBe(
      'mobile.restTimer.pillLabel:1m',
    );
  });

  it('keeps counting past the target and turns the digits red', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(60);
    // Exactly at the target is not yet past it.
    expect(elapsedColor(container)).toBe('#111111');

    advanceSeconds(5);
    expect(elapsedText(container)).toBe('1:05');
    expect(elapsedColor(container)).toBe('#C81E1E');
  });

  it('freezes the number while paused and says so to a screen reader', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(20);
    act(() => pauseRestTimer(harness.nowMs));
    expect(elapsedText(container)).toBe('0:20');

    advanceSeconds(45);
    expect(elapsedText(container)).toBe('0:20');
    expect(elapsedColor(container)).toBe('#666666');
    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.pausedAria:0:20',
    );
  });

  it('opens the sheet on tap', () => {
    const onPress = vi.fn();
    armWithTick();
    const { getByTestId } = render(<RestTimerPill onPress={onPress} />);

    fireEvent.click(getByTestId('rest-timer-pill'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('long-press pauses and resumes the real timer, with a medium haptic each way', () => {
    armWithTick();
    render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(10);
    act(() => harness.pressable?.onLongPress?.());
    expect(getRestTimerState().isRunning).toBe(false);
    expect(hapticMedium).toHaveBeenCalledTimes(1);

    act(() => harness.pressable?.onLongPress?.());
    expect(getRestTimerState().isRunning).toBe(true);
    expect(hapticMedium).toHaveBeenCalledTimes(2);
  });

  it('offers a reset accessibility action that restarts the cycle', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);
    advanceSeconds(40);

    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-actions')).toBe(
      'rest-timer-reset:mobile.restTimer.resetAction',
    );

    act(() => harness.pressable?.onAccessibilityAction?.({ nativeEvent: { actionName: 'rest-timer-reset' } }));
    expect(elapsedText(container)).toBe('0:00');
  });

  it('shows the next-climb glyph only while auto-advance is armed', () => {
    armWithTick();
    const { container, rerender } = render(<RestTimerPill onPress={vi.fn()} />);
    expect(container.querySelector('[data-icon="skip.next"]')).toBeNull();

    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    act(() => {
      // Nudge the store so the pill re-reads the settings snapshot.
      pauseRestTimer(harness.nowMs);
    });
    rerender(<RestTimerPill onPress={vi.fn()} />);
    expect(container.querySelector('[data-icon="skip.next"]')).not.toBeNull();
  });

  it('keeps the auto-advance glyph in the compact drawer tier and drops the second line', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} compact />);

    expect(container.querySelector('[data-surface="true"]')?.getAttribute('data-height')).toBe('32');
    expect(container.querySelector('[data-testid="rest-timer-pill-secondary"]')).toBeNull();
    expect(container.querySelector('[data-icon="skip.next"]')).not.toBeNull();
  });

  it('stops the 1 Hz interval when the timer is not running', () => {
    armWithTick();
    render(<RestTimerPill onPress={vi.fn()} />);
    advanceSeconds(5);
    const runningTimers = vi.getTimerCount();

    act(() => pauseRestTimer(harness.nowMs));
    expect(vi.getTimerCount()).toBeLessThan(runningTimers);
  });
});
