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
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { 'data-testid': testID, 'data-label': accessibilityLabel }, children),
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
vi.mock('../../../theme/typography', () => ({
  CHROME_LABEL_MAX_FONT_SCALE: 1.2,
  REST_CLOCK_MAX_FONT_SCALE: 1.3,
}));

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
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  getRestTimerState,
} from '../../../lib/rest-timer-store';
import { RestTimerHeroClock, RestTimerPill } from '../RestTimerPill';

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

  it('counts DOWN from the rest, and drops the caption the number now says', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    // 1m rest: the clock opens at the full rest, not at zero.
    expect(elapsedText(container)).toBe('1:00');
    advanceSeconds(30);
    expect(elapsedText(container)).toBe('0:30');
    expect(elapsedColor(container)).toBe('#111111');
    // "Rest · 1m" beside a ticking countdown just repeats the number.
    expect(container.querySelector('[data-testid="rest-timer-pill-secondary"]')).toBeNull();
  });

  it('runs past zero into the negative and turns the digits red', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(60);
    // Exactly at zero is not yet over.
    expect(elapsedText(container)).toBe('0:00');
    expect(elapsedColor(container)).toBe('#111111');

    advanceSeconds(5);
    expect(elapsedText(container)).toBe('-0:05');
    expect(elapsedColor(container)).toBe('#C81E1E');
  });

  it('counts UP when no rest is set, because there is nothing to count down from', () => {
    harness.settings = { ...harness.settings, restTimerTargetSeconds: null };
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    expect(elapsedText(container)).toBe('0:00');
    advanceSeconds(30);
    expect(elapsedText(container)).toBe('0:30');
  });

  it('speaks the overrun without the sign, which does not read aloud', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(30);
    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.countdownAria:0:30',
    );

    advanceSeconds(45);
    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.overrunAria:0:15',
    );
  });

  it('freezes the number while paused and says so to a screen reader', () => {
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    advanceSeconds(20);
    act(() => pauseRestTimer(harness.nowMs));
    expect(elapsedText(container)).toBe('0:40');

    advanceSeconds(45);
    expect(elapsedText(container)).toBe('0:40');
    expect(elapsedColor(container)).toBe('#666666');
    expect(container.querySelector('[data-testid="rest-timer-pill"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.pausedAria:0:40',
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
    // Reset puts the whole rest back on the clock.
    expect(elapsedText(container)).toBe('1:00');
  });

  it('carries no auto-advance glyph — the pill is time, the sheet is settings', () => {
    // The brand-violet skip glyph read as a button you could press, next to a
    // pill that IS pressable but opens the sheet. Auto-advance state lives in the
    // sheet and the Record-tab card.
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} />);

    expect(container.querySelector('[data-icon="skip.next"]')).toBeNull();
    expect(container.querySelector('[data-testid="rest-timer-pill-auto-advance"]')).toBeNull();
  });

  it('drops the second line in the compact drawer tier', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    armWithTick();
    const { container } = render(<RestTimerPill onPress={vi.fn()} compact />);

    expect(container.querySelector('[data-surface="true"]')?.getAttribute('data-height')).toBe('32');
    expect(container.querySelector('[data-testid="rest-timer-pill-secondary"]')).toBeNull();
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

/**
 * The sheet's hero. It lives in this file because it calls
 * `useRestTimerDisplay` — the 1 Hz hook only a leaf may call — so its specs
 * live here too, against the same real store.
 *
 * What it has to get right is the CAPTION: it is the only thing on the sheet
 * that says which phase the machine is in, and (while simply running) which rest
 * length the countdown is measured against.
 */
describe('RestTimerHeroClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.nowMs = START_MS;
    harness.settings = { restTimerTargetSeconds: 120, restTimerMode: 'afterTick', restTimerAutoAdvance: false };
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
    vi.useRealTimers();
  });

  function heroDigits(container: HTMLElement) {
    return container.querySelector('[data-testid="rest-timer-hero-digits"]');
  }

  function heroCaption(container: HTMLElement): string {
    return container.querySelector('[data-testid="rest-timer-hero-caption"]')?.textContent ?? '';
  }

  it('renders nothing while the timer is disarmed', () => {
    const { container } = render(<RestTimerHeroClock />);
    expect(container.querySelector('[data-testid="rest-timer-hero-clock"]')).toBeNull();
  });

  it('counts down in the label colour and names the rest it is counting against', () => {
    armWithTick();
    const { container } = render(<RestTimerHeroClock />);

    expect(heroDigits(container)?.textContent).toBe('2:00');
    expect(heroDigits(container)?.getAttribute('data-color')).toBe('#111111');
    // `formatRestTimerElapsed`, so the caption is byte-identical to the rail chip
    // the climber tapped — `formatRestTimerTarget` would print "2m" instead.
    expect(heroCaption(container)).toBe('mobile.restTimer.clockCaptionRest:2:00');
  });

  it('says it is counting up when no rest length is set', () => {
    harness.settings = { ...harness.settings, restTimerTargetSeconds: null };
    armWithTick();
    const { container } = render(<RestTimerHeroClock />);

    expect(heroDigits(container)?.textContent).toBe('0:00');
    expect(heroCaption(container)).toBe('mobile.restTimer.clockCaptionCountUp');
  });

  it('dims to tertiary while waiting for the first tick', () => {
    act(() => armRestTimer('afterTick', harness.nowMs, null));
    const { container } = render(<RestTimerHeroClock />);

    expect(heroDigits(container)?.getAttribute('data-color')).toBe('#AAAAAA');
    expect(heroCaption(container)).toBe('mobile.restTimer.waitingForTick');
  });

  it('dims to secondary and says so when paused', () => {
    armWithTick();
    advanceSeconds(30);
    act(() => pauseRestTimer(harness.nowMs));
    const { container } = render(<RestTimerHeroClock />);

    expect(heroDigits(container)?.getAttribute('data-color')).toBe('#666666');
    expect(heroCaption(container)).toBe('mobile.restTimer.clockCaptionPaused');
  });

  it('turns red past the rest — never a success green', () => {
    armWithTick();
    const { container } = render(<RestTimerHeroClock />);

    advanceSeconds(125);
    expect(heroDigits(container)?.textContent).toBe('-0:05');
    expect(heroDigits(container)?.getAttribute('data-color')).toBe('#C81E1E');
    expect(heroCaption(container)).toBe('mobile.restTimer.clockCaptionOver');
  });

  it('reuses the queue-ended caption when auto-advance ran out of climbs', () => {
    armWithTick();
    act(() => noteRestTimerQueueEnded());
    const { container } = render(<RestTimerHeroClock />);

    expect(heroDigits(container)?.getAttribute('data-color')).toBe('#666666');
    expect(heroCaption(container)).toBe('mobile.restTimer.queueEnded');
  });

  it('is ONE accessible element carrying the same sentence the pill speaks', () => {
    armWithTick();
    advanceSeconds(30);
    const { container } = render(<RestTimerHeroClock />);

    expect(container.querySelector('[data-testid="rest-timer-hero-clock"]')?.getAttribute('data-label')).toBe(
      'mobile.restTimer.countdownAria:1:30. mobile.restTimer.clockCaptionRest:2:00',
    );
  });
});
