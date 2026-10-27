// @vitest-environment jsdom
//
// The load-bearing test here is the LAST describe block: the root pill's render
// gate is driven against the REAL `computeBottomChromeMetrics`, so the two can
// never drift. Disagreement is a visible bug either way round — a dead 54pt gap
// under the last list row, or a pill sitting on top of it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const harness = vi.hoisted(() => ({
  insideTabs: true,
  restTimerBottom: 83,
  widthClass: 'compact' as 'compact' | 'regular',
  windowWidth: 390,
  workoutStartPending: false,
  hasWorkoutClimb: true,
  startWorkout: vi.fn(),
}));

vi.mock('../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: 'session-1' }) }));
vi.mock('../../../lib/workout-run-store', () => ({
  useWorkoutRunPendingStart: () => harness.workoutStartPending,
}));
vi.mock('../../../hooks/use-start-workout', () => ({
  useStartWorkout: () => ({
    pending: harness.workoutStartPending,
    firstItem: harness.hasWorkoutClimb ? { climb: { name: 'First climb' } } : null,
    startWorkout: harness.startWorkout,
  }),
}));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-overlay': 'true', 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: harness.windowWidth, height: 844 }),
}));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    insideTabs: harness.insideTabs,
    restTimerBottom: harness.restTimerBottom,
  }),
}));

vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ widthClass: harness.widthClass }),
}));

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

vi.mock('../RestTimerPill', () => ({
  RestTimerPill: ({ compact, onPress }: { compact?: boolean; onPress: () => void }) =>
    createElement('button', { 'data-testid': 'pill', 'data-compact': String(Boolean(compact)), onClick: onPress }),
  WorkoutStartPill: ({
    compact,
    onPress,
    firstClimbName,
  }: {
    compact?: boolean;
    onPress: () => void;
    firstClimbName: string | null;
  }) =>
    createElement('button', {
      'data-testid': 'start-workout',
      'data-compact': String(Boolean(compact)),
      onClick: onPress,
      disabled: firstClimbName === null,
    }),
}));

vi.mock('../RestTimerSheet', () => ({
  RestTimerSheet: ({ visible }: { visible: boolean }) =>
    createElement('div', { 'data-testid': 'sheet', 'data-visible': String(visible) }),
}));

import { fireEvent } from '@testing-library/react';
import { armRestTimer, resetRestTimerStoreForTests } from '../../../lib/rest-timer-store';
import { computeBottomChromeMetrics } from '../../../hooks/bottom-chrome-metrics';
import { RestTimerPillHost, RootRestTimerPillHost, shouldRenderRestTimerPill } from '../RestTimerPillHost';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');

function arm() {
  armRestTimer('afterTick', NOW_MS, null);
}

describe('RestTimerPillHost', () => {
  beforeEach(() => {
    harness.insideTabs = true;
    harness.widthClass = 'compact';
    harness.windowWidth = 390;
    harness.workoutStartPending = false;
    harness.hasWorkoutClimb = true;
    harness.startWorkout.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
  });

  it('renders nothing while the timer is disarmed', () => {
    const { queryByTestId } = render(<RestTimerPillHost />);
    expect(queryByTestId('pill')).toBeNull();
    expect(queryByTestId('sheet')).toBeNull();
  });

  it('brings its OWN sheet, opened by its own pill', () => {
    arm();
    const { getByTestId } = render(<RestTimerPillHost />);

    expect(getByTestId('sheet').getAttribute('data-visible')).toBe('false');
    fireEvent.click(getByTestId('pill'));
    expect(getByTestId('sheet').getAttribute('data-visible')).toBe('true');
  });

  it('passes the compact tier through to the pill (the play-drawer mount)', () => {
    arm();
    const { getByTestId } = render(<RestTimerPillHost compact />);
    expect(getByTestId('pill').getAttribute('data-compact')).toBe('true');
  });

  it('offers Start workout before an unarmed timer and launches instead of opening settings', () => {
    harness.workoutStartPending = true;
    const { getByTestId, queryByTestId } = render(<RestTimerPillHost />);
    fireEvent.click(getByTestId('start-workout'));
    expect(harness.startWorkout).toHaveBeenCalledOnce();
    expect(queryByTestId('sheet')).toBeNull();
    expect(queryByTestId('pill')).toBeNull();
  });

  it('keeps Start disabled when every workout climb was removed', () => {
    harness.workoutStartPending = true;
    harness.hasWorkoutClimb = false;
    const { getByTestId } = render(<RestTimerPillHost compact />);
    const start = getByTestId('start-workout') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('data-compact')).toBe('true');
    fireEvent.click(start);
    expect(harness.startWorkout).not.toHaveBeenCalled();
  });

  it('switches from Start to the timer after launch while preserving the mounted host', () => {
    harness.workoutStartPending = true;
    const { rerender, queryByTestId, getByTestId } = render(<RestTimerPillHost />);
    arm();
    harness.workoutStartPending = false;
    rerender(<RestTimerPillHost />);
    expect(queryByTestId('start-workout')).toBeNull();
    fireEvent.click(getByTestId('pill'));
    expect(getByTestId('sheet').getAttribute('data-visible')).toBe('true');
  });
});

describe('RootRestTimerPillHost', () => {
  beforeEach(() => {
    harness.insideTabs = true;
    harness.restTimerBottom = 83;
    harness.widthClass = 'compact';
    harness.windowWidth = 390;
    harness.workoutStartPending = false;
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
  });

  it('anchors the overlay at restTimerBottom, verbatim', () => {
    arm();
    harness.restTimerBottom = 139;
    const { getByTestId } = render(<RootRestTimerPillHost />);

    const overlayStyle = getByTestId('pill').parentElement?.getAttribute('data-style') ?? '';
    expect(overlayStyle).toContain('"bottom":139');
  });

  it('does not render off the tabs', () => {
    arm();
    harness.insideTabs = false;
    const { queryByTestId } = render(<RootRestTimerPillHost />);
    expect(queryByTestId('pill')).toBeNull();
  });

  it('mounts the prepared Start pill even before the timer is armed', () => {
    harness.workoutStartPending = true;
    const { getByTestId } = render(<RootRestTimerPillHost />);
    expect(getByTestId('start-workout')).toBeTruthy();
  });

  it('does not render on the regular-width iPad shell, where the pane owns the queue', () => {
    arm();
    harness.widthClass = 'regular';
    harness.windowWidth = 1194;
    const { queryByTestId } = render(<RootRestTimerPillHost />);
    expect(queryByTestId('pill')).toBeNull();
  });
});

/**
 * The render gate and the bottom-chrome reserve are two statements of one rule.
 * This drives both from the same inputs and demands they agree.
 */
describe('the root pill gate matches the bottom-chrome reserve', () => {
  const baseInputs = {
    uiVariant: 'liquidGlass' as const,
    usesNativeTabBar: true,
    insetsBottom: 34,
    onAccessorySurface: true,
    hasCurrentClimb: true,
    nativeAccessoryPresented: true,
  };

  /** Does the geometry actually leave room for a pill under these conditions? */
  function reservesForPill(inputs: { insideTabs: boolean; usesSidebar: boolean; detailPaneOwnsQueue: boolean }) {
    const shared = { ...baseInputs, ...inputs };
    const armedMetrics = computeBottomChromeMetrics({ ...shared, restTimerArmed: true });
    const unarmedMetrics = computeBottomChromeMetrics({ ...shared, restTimerArmed: false });
    return armedMetrics.scrollBottomPadding !== unarmedMetrics.scrollBottomPadding;
  }

  const cases = [
    { insideTabs: true, usesSidebar: false, detailPaneOwnsQueue: false, label: 'phone, on a tab' },
    { insideTabs: false, usesSidebar: false, detailPaneOwnsQueue: false, label: 'phone, off the tabs' },
    { insideTabs: true, usesSidebar: true, detailPaneOwnsQueue: true, label: 'iPad sidebar + detail pane' },
    { insideTabs: true, usesSidebar: true, detailPaneOwnsQueue: false, label: 'iPad sidebar, narrow window' },
  ];

  for (const { label, ...inputs } of cases) {
    it(`agrees for ${label}`, () => {
      const renders = shouldRenderRestTimerPill({
        armed: true,
        insideTabs: inputs.insideTabs,
        usesSidebar: inputs.usesSidebar,
      });
      expect(renders).toBe(reservesForPill(inputs));
    });
  }

  it('reserves nothing and renders nothing while disarmed', () => {
    expect(shouldRenderRestTimerPill({ armed: false, insideTabs: true, usesSidebar: false })).toBe(false);
    expect(
      computeBottomChromeMetrics({ ...baseInputs, insideTabs: true, restTimerArmed: false }).scrollBottomPadding,
    ).toBe(computeBottomChromeMetrics({ ...baseInputs, insideTabs: true }).scrollBottomPadding);
  });

  for (const inputs of cases) {
    it(`reserves exactly one pill for a prepared workout: ${inputs.label}`, () => {
      const { label: _label, ...geometry } = inputs;
      const prepared = computeBottomChromeMetrics({ ...baseInputs, ...geometry, workoutStartPending: true });
      const armed = computeBottomChromeMetrics({ ...baseInputs, ...geometry, restTimerArmed: true });
      const both = computeBottomChromeMetrics({
        ...baseInputs,
        ...geometry,
        restTimerArmed: true,
        workoutStartPending: true,
      });
      expect(prepared).toEqual(armed);
      expect(both).toEqual(armed);
      expect(
        shouldRenderRestTimerPill({
          armed: false,
          workoutStartPending: true,
          insideTabs: geometry.insideTabs,
          usesSidebar: geometry.usesSidebar,
        }),
      ).toBe(reservesForPill(geometry));
    });
  }
});
