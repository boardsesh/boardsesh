// @vitest-environment jsdom
//
// "Set by your workout" (#5380, #6231). While a timed workout block paces the
// rest timer, the sheet and the Record tab's arm row show what the block runs
// instead of the climber's own rest length, cadence and auto-advance controls,
// which a stage overrides. The rest-timer store is real: the row follows the
// stage pacing the sync writes, and a stage that goes away mid-sheet brings the
// controls straight back.
//
// The sheet's own behaviour is pinned in rest-timer-sheet.test.tsx; its leaf
// controls are stubbed here to what this file asserts on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const harness = vi.hoisted(() => ({
  isCrewSession: false,
  inAppBoardConnection: 'connectedByMe',
  settings: {} as Record<string, unknown>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [harness.settings[key], vi.fn()],
  getSetting: (key: string) => harness.settings[key],
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => 0 }));
// Native capability is covered by rest-timer-sheet; these suites exercise crew/workout UI.
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({ sessionPresenceSupportsRestTimer: true }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111111', secondaryLabel: '#666666' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: 'session-1' }),
  useIsCrewSession: () => harness.isCrewSession,
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    inAppBoardConnection: harness.inAppBoardConnection,
    localConnected: false,
    holderDisplayName: null,
  }),
}));
vi.mock('../RestTimerPill', () => ({ RestTimerHeroClock: () => null }));
vi.mock('../RestLengthPicker', () => ({
  RestLengthPicker: () => createElement('div', { 'data-control': 'rest-length' }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', { 'data-testid': 'sheet' }, children) : null,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title }: { title: string }) => createElement('button', null, title),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label }: { label: string }) => createElement('div', { 'data-control': label }),
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: () => createElement('div', { 'data-control': 'cadence' }),
}));
vi.mock('../../navigation/ScrollableTabs', () => ({ ScrollableTabs: () => null }));
vi.mock('../../tick/TickDestructiveRow', () => ({
  TickDestructiveRow: ({ label }: { label: string }) => createElement('button', null, label),
}));

import { applyRestTimerStagePacing, armRestTimer, resetRestTimerStoreForTests } from '../../../lib/rest-timer-store';
import type { RestTimerStagePacing } from '../../../lib/rest-timer-pacing';
import { RestTimerSheet } from '../RestTimerSheet';

const FOUR_BY_FOUR: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-4x4',
  kind: 'fourByFour',
  queueItemUuid: 'a1',
  mode: 'afterTick',
  targetSeconds: null,
  advanceOn: 'tick',
  closesSet: false,
  reps: { logged: 1, perSet: 4 },
  stagePacing: {
    mode: 'afterTick',
    restSeconds: 0,
    advanceOn: 'set',
    sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
  },
};

/** Triples with 0:45 between reps. */
const TRIPLES: RestTimerStagePacing = {
  ...FOUR_BY_FOUR,
  targetSeconds: 45,
  reps: { logged: 1, perSet: 3 },
  stagePacing: {
    mode: 'afterTick',
    restSeconds: 45,
    advanceOn: 'set',
    sets: { repsPerSet: 3, restBetweenSetsSeconds: 300 },
  },
};

const LIMIT: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-limit',
  kind: 'limitBouldering',
  queueItemUuid: 'l1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
};

const ON_THE_MINUTE: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-emom',
  kind: 'onTheMinute',
  queueItemUuid: 'e1',
  mode: 'onTheMinute',
  targetSeconds: 45,
  advanceOn: 'deadline',
  closesSet: false,
  stagePacing: { mode: 'onTheMinute', restSeconds: 45 },
};

const WARM_UP: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-warm',
  kind: 'warmUp',
  queueItemUuid: 'w1',
  mode: 'afterTick',
  targetSeconds: 30,
  advanceOn: 'tick',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 30, advanceOn: 'tick' },
};

const CLIMBERS_OWN_CONTROLS = [
  '[data-control="rest-length"]',
  '[data-control="cadence"]',
  '[data-control="mobile.restTimer.autoAdvance"]',
];

function paceWith(stage: RestTimerStagePacing | null) {
  act(() => applyRestTimerStagePacing(stage, 0, 'none'));
}

function renderSheet() {
  return render(<RestTimerSheet visible onClose={() => {}} />);
}

function visibleControls(container: HTMLElement): string[] {
  return CLIMBERS_OWN_CONTROLS.filter((selector) => container.querySelector(selector) !== null);
}

beforeEach(() => {
  harness.isCrewSession = false;
  harness.inAppBoardConnection = 'connectedByMe';
  harness.settings = { restTimerTargetSeconds: 120, restTimerMode: 'afterTick', restTimerAutoAdvance: false };
  armRestTimer('afterTick', 0, 'session-1');
});

afterEach(() => {
  cleanup();
  resetRestTimerStoreForTests();
});

describe('RestTimerSheet under a workout stage', () => {
  it('shows the climber’s own controls while no stage paces the timer', () => {
    const { container, queryByText } = renderSheet();
    expect(visibleControls(container)).toEqual(CLIMBERS_OWN_CONTROLS);
    expect(queryByText('mobile.restTimer.workoutPacingTitle')).toBeNull();
  });

  it('shows what a 4x4 runs, once, in place of the rest length, cadence and auto-advance', () => {
    paceWith(FOUR_BY_FOUR);
    const { container, getAllByText, getByText } = renderSheet();

    expect(visibleControls(container)).toEqual([]);
    expect(getAllByText('mobile.restTimer.workoutPacingTitle')).toHaveLength(1);
    // No rest between reps says nothing about it.
    expect(getByText('mobile.restTimer.workoutPacingSets:mobile.session.preGeneratorFourByFour,4,3:00')).toBeTruthy();
    expect(getByText('mobile.restTimer.workoutPacingAdvanceSet')).toBeTruthy();
    // Pause, Reset and Turn off stay: they act on this rest, not on the settings.
    expect(getByText('mobile.restTimer.turnOff')).toBeTruthy();
  });

  it('names a 4x4’s rest between reps when it has one', () => {
    paceWith(TRIPLES);
    const { getByText } = renderSheet();
    expect(
      getByText('mobile.restTimer.workoutPacingSetsWithRepRest:mobile.session.preGeneratorFourByFour,3,0:45,5:00'),
    ).toBeTruthy();
    expect(getByText('mobile.restTimer.workoutPacingAdvanceSet')).toBeTruthy();
  });

  it('says a limit block moves on only after a send', () => {
    paceWith(LIMIT);
    const { getByText } = renderSheet();
    expect(
      getByText('mobile.restTimer.workoutPacingRest:mobile.session.preGeneratorLimitBouldering,3:00'),
    ).toBeTruthy();
    expect(getByText('mobile.restTimer.workoutPacingAdvanceSend')).toBeTruthy();
  });

  it('names the interval of an on-the-minute block', () => {
    paceWith(ON_THE_MINUTE);
    const { getByText } = renderSheet();
    expect(
      getByText('mobile.restTimer.workoutPacingInterval:mobile.session.preGeneratorOnTheMinute,0:45'),
    ).toBeTruthy();
    expect(getByText('mobile.restTimer.workoutPacingAdvanceBeat')).toBeTruthy();
  });

  it('names a warm-up queued after the workout "Cool-down", and any other warm-up "Warm-up"', () => {
    paceWith({ ...WARM_UP, isCoolDown: true });
    const coolDown = renderSheet();
    expect(
      coolDown.getByText('mobile.restTimer.workoutPacingRest:mobile.session.preWorkoutSectionCoolDown,0:30'),
    ).toBeTruthy();
    cleanup();

    // The store ignores a re-apply that only differs in `isCoolDown`, so clear it.
    paceWith(null);
    paceWith(WARM_UP);
    const warmUp = renderSheet();
    expect(
      warmUp.getByText('mobile.restTimer.workoutPacingRest:mobile.session.preWorkoutSectionWarmUp,0:30'),
    ).toBeTruthy();
  });

  it('tells a crew passenger the wall is not theirs to move, stage or not', () => {
    harness.isCrewSession = true;
    harness.inAppBoardConnection = 'heldByPeer';
    paceWith(LIMIT);
    const { getByText, queryByText } = renderSheet();
    expect(getByText('mobile.restTimer.autoAdvanceBlocked')).toBeTruthy();
    expect(queryByText('mobile.restTimer.workoutPacingAdvanceSend')).toBeNull();
  });

  it('swaps back and forth while open as the wall moves in and out of the block', () => {
    const { container, queryByText } = renderSheet();

    paceWith(LIMIT);
    expect(visibleControls(container)).toEqual([]);
    expect(queryByText('mobile.restTimer.workoutPacingTitle')).not.toBeNull();

    paceWith(null);
    expect(visibleControls(container)).toEqual(CLIMBERS_OWN_CONTROLS);
    expect(queryByText('mobile.restTimer.workoutPacingTitle')).toBeNull();
  });
});
