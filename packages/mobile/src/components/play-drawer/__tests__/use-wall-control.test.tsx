// @vitest-environment jsdom
// The one handler behind every view of the board control (#7000): each tap
// action runs its runner, a hold opens the board sheet only with a link, and
// each event fires once with the view that was used.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  tapped: vi.fn(),
  shown: vi.fn(),
  opened: vi.fn(),
  ended: vi.fn(),
  swiped: vi.fn(),
}));
const haptics = vi.hoisted(() => ({ hapticMedium: vi.fn(), hapticWarning: vi.fn(), hapticLight: vi.fn() }));
const announceQueued = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackWallControlTapped: analytics.tapped,
  trackWallControlSwiped: analytics.swiped,
  trackWallControlShown: analytics.shown,
  trackDriveModeEnded: analytics.ended,
}));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardControlsOpened: analytics.opened }));
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import {
  DISCONNECT_TAP_GUARD_MS,
  useWallControl,
  type DriveStartOutcome,
  type WallControlRunners,
} from '../use-wall-control';
import {
  EMPTY_WALL_CONTROL,
  resolveWallControl,
  type WallControlAction,
  type WallControlInput,
  type WallControlModel,
} from '../wall-control';
import {
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../drive-mode-store';

type MockRunners = {
  [Name in Exclude<keyof WallControlRunners, 'drive'>]: ReturnType<typeof vi.fn<() => void>>;
} & { drive: ReturnType<typeof vi.fn<(startedBy: string) => DriveStartOutcome>> };

function runners(): MockRunners {
  return {
    light: vi.fn<() => void>(),
    toggle: vi.fn<() => void>(),
    disconnect: vi.fn<() => void>(),
    openSheet: vi.fn<() => void>(),
    lightAgain: vi.fn<() => void>(),
    moveToBoard: vi.fn<() => void>(),
    drive: vi.fn<(startedBy: string) => DriveStartOutcome>(() => 'started'),
  };
}

function setup(model: WallControlModel, run = runners(), visible = true) {
  const hook = renderHook(
    (props: { model: WallControlModel; linked?: boolean }) =>
      useWallControl({
        model: props.model,
        runners: run,
        climbUuid: 'climb-1',
        playerOpen: true,
        visible,
        linked: props.linked ?? true,
      }),
    { initialProps: { model } as { model: WallControlModel; linked?: boolean } },
  );
  return { hook, run };
}

const modelFor = (
  state: WallControlModel['state'],
  tapAction: WallControlAction,
  extra: Partial<WallControlModel> = {},
) =>
  ({
    ...EMPTY_WALL_CONTROL,
    state,
    tapAction,
    // The resolver's rule: a bulb never stops driving.
    bulbTapAction: tapAction === 'stop_driving' ? 'disconnect' : tapAction,
    ...extra,
  }) as WallControlModel;

describe('useWallControl', () => {
  beforeEach(() => {
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  it.each([
    ['connect', 'connect', 'light'],
    ['put_on_wall', 'put_on_wall', 'light'],
    ['dark', 'relight', 'light'],
    ['crew', 'relay', 'toggle'],
    ['take_wall', 'take_wall', 'toggle'],
    ['release_wall', 'release_wall', 'toggle'],
    ['lit', 'disconnect', 'disconnect'],
  ] as const)('a tap on %s runs %s through %s, and logs it once', (state, action, runner) => {
    const { hook, run } = setup(modelFor(state, action));
    act(() => hook.result.current.press('button'));
    expect(run[runner]).toHaveBeenCalledOnce();
    for (const other of (['light', 'toggle', 'disconnect', 'openSheet'] as const).filter((name) => name !== runner)) {
      expect(run[other]).not.toHaveBeenCalled();
    }
    expect(analytics.tapped).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state, action, control: 'button' });
  });

  it('moves to the gym board on a tap on Put on {board}, with a medium buzz, and logs it once', () => {
    const { hook, run } = setup(modelFor('move_to_board', 'move_to_board', { gymBoardName: 'Kilter' }));
    act(() => hook.result.current.press('button'));
    expect(run.moveToBoard).toHaveBeenCalledOnce();
    for (const other of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain'] as const) {
      expect(run[other]).not.toHaveBeenCalled();
    }
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({
      state: 'move_to_board',
      action: 'move_to_board',
      control: 'button',
    });
  });

  // #7113: a press on the frosted button stops driving and keeps the link.
  it('stops driving on You are driving the wall: no disconnect, a light buzz, and says so', () => {
    resetDriveModeForTests();
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 });
    markDriveLive();
    const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
    act(() => hook.result.current.press('button'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    for (const runner of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain', 'moveToBoard'] as const) {
      expect(run[runner]).not.toHaveBeenCalled();
    }
    expect(haptics.hapticLight).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'stop_driving', control: 'button' });
    resetDriveModeForTests();
  });

  // Review: a bulb draws no frost, so a tap there disconnects, as it always has.
  it.each(['bulb', 'mini_bar'] as const)('lets go of the board from the %s while driving', (control) => {
    resetDriveModeForTests();
    const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
    act(() => hook.result.current.press(control));
    expect(run.disconnect).toHaveBeenCalledOnce();
    expect(isDrivingStoppedForLink()).toBe(false);
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control });
  });

  // A double tap on the frost must not stop driving and then let go of a crew's board.
  it('drops the second tap of a double tap on You are driving the wall', () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
      act(() => hook.result.current.press('button'));
      hook.rerender({ model: modelFor('lit', 'disconnect') });
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      resetDriveModeForTests();
    }
  });

  it('lets go of the board with a warning buzz, and says so once the link drops', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    act(() => hook.result.current.press('bulb'));
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control: 'bulb' });
    // Not at the tap: the disconnect could still fail.
    expect(announceQueued).not.toHaveBeenCalled();

    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
  });

  it('says nothing when the link drops without a tap-disconnect (auto-disconnect, the sheet)', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  // Fable review: the provider marks the link down before the adapter lets go,
  // so a double tap's second tap read Put on board and started a connect.
  it('turns a double tap on Disconnect board into one disconnect and no connect', () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'disconnect'));
      act(() => hook.result.current.press('button'));
      // The link already reads down: the model says Put on board.
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).toHaveBeenCalledOnce();
      expect(run.light).not.toHaveBeenCalled();
      expect(analytics.tapped).toHaveBeenCalledOnce();

      // A deliberate tap after the guard connects again.
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a noop tap but runs nothing, and ignores a tap while a connect is in flight', () => {
    const { hook, run } = setup(modelFor('lit', 'noop'));
    act(() => hook.result.current.press('mini_bar'));
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'noop', control: 'mini_bar' });
    expect(Object.values(run).some((runner) => runner.mock.calls.length > 0)).toBe(false);

    analytics.tapped.mockClear();
    hook.rerender({ model: modelFor('connect', 'connect', { pending: true }) });
    act(() => hook.result.current.press('button'));
    expect(analytics.tapped).not.toHaveBeenCalled();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('opens the board sheet on a hold while this phone holds the link, saying which view', () => {
    const { hook, run } = setup(modelFor('lit', 'disconnect', { longPress: 'sheet' }));
    act(() => hook.result.current.longPress('mini_bar'));
    expect(run.openSheet).toHaveBeenCalledOnce();
    expect(analytics.opened).toHaveBeenCalledWith({ surface: 'play_drawer', source: 'mini_bar' });
    expect(run.disconnect).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it('does nothing on a hold without a link', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    act(() => hook.result.current.longPress('button'));
    expect(run.openSheet).not.toHaveBeenCalled();
    expect(analytics.opened).not.toHaveBeenCalled();
  });

  it('keeps its handlers across renders and acts on the latest model', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    const first = hook.result.current;
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    expect(hook.result.current.press).toBe(first.press);
    act(() => first.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('counts Wall Control Shown for the control that asks, once', () => {
    const { hook } = setup(modelFor('connect', 'connect'));
    hook.rerender({ model: modelFor('connect', 'connect') });
    expect(analytics.shown).toHaveBeenCalledOnce();
    expect(analytics.shown).toHaveBeenCalledWith({ state: 'connect', climbUuid: 'climb-1' });
  });
});

// #7113: the wall button's swipe and its "Light every climb" action share one runner.
describe('useWallControl drive', () => {
  it('starts a drive where the model offers the swipe, and passes the outcome back', () => {
    const { hook, run } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive' }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(run.drive).toHaveBeenCalledExactlyOnceWith('action');
    expect(outcome).toBe('started');
    // A start is not a tap: it logs no Wall Control Tapped.
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it("passes a refusal for a crewmate's board back untouched", () => {
    const run = runners();
    run.drive.mockReturnValue('needs_handoff');
    const { hook } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive', holder: 'crew' }), run);
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(outcome).toBe('needs_handoff');
  });

  it('runs nothing where the model offers no swipe', () => {
    const { hook, run } = setup(modelFor('crew', 'relay', { swipeAction: null }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(run.drive).not.toHaveBeenCalled();
    expect(outcome).toBe('unavailable');
  });
});

// #7113 PR 3: Wall Control Swiped, once per gesture, in the state it began in.
describe('useWallControl swipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a drive with the state the swipe began in', () => {
    const { hook, run } = setup(modelFor('connect', 'connect', { swipeAction: 'drive' }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.swipe('button');
    });
    expect(run.drive).toHaveBeenCalledExactlyOnceWith('swipe');
    expect(outcome).toBe('started');
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({ state: 'connect', outcome: 'drive', control: 'button' });
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it('logs a refusal when nothing starts', () => {
    const run = runners();
    run.drive.mockReturnValue('needs_handoff');
    const { hook } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive', holder: 'crew' }), run);
    act(() => {
      hook.result.current.swipe('button');
    });
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({
      state: 'put_on_wall',
      outcome: 'refused',
      control: 'button',
    });
  });

  it('logs a cancel and runs nothing', () => {
    const { hook, run } = setup(modelFor('dark', 'relight', { swipeAction: 'drive' }));
    act(() => {
      hook.result.current.swipeCancelled('button');
    });
    expect(run.drive).not.toHaveBeenCalled();
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({
      state: 'dark',
      outcome: 'cancelled',
      control: 'button',
    });
  });

  it('never logs a swipe for the screen-reader action', () => {
    const { hook } = setup(modelFor('connect', 'connect', { swipeAction: 'drive' }));
    act(() => {
      hook.result.current.drive('button');
    });
    expect(analytics.swiped).not.toHaveBeenCalled();
  });
});

// #7113 QA (Marco): solo, a press that puts the climb up ends in driving, on
// the button and the bulb; in a crew it stays a one-off put.
describe('useWallControl: a solo press ends in driving', () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  /** A preview with the link up, after a press on You are driving the wall stopped it. */
  const PREVIEW_AFTER_STOP: WallControlInput = {
    commitButton: 'putOnWall',
    pressAction: 'disconnect',
    holderIsAuthoritative: false,
    localConnected: true,
    pending: false,
    displayedLit: false,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    autoDisconnectWarning: false,
    navigationCommits: false,
    drivingStopped: true,
  };
  const previewAfterStop = (input: Partial<WallControlInput>) =>
    resolveWallControl({ ...PREVIEW_AFTER_STOP, ...input });

  // [case, model input, control, drive runner called, light runner called, stopped after]
  it.each<[string, Partial<WallControlInput>, 'button' | 'bulb', boolean, boolean, boolean]>([
    ['solo, stopped, Light on swipe on', { solo: true, lightOnSwipe: true }, 'button', false, true, false],
    ['solo, stopped, Light on swipe on, the bulb', { solo: true, lightOnSwipe: true }, 'bulb', false, true, false],
    ['solo, Light on swipe off', { solo: true, lightOnSwipe: false }, 'button', true, false, false],
    ['solo, Light on swipe off, the bulb', { solo: true, lightOnSwipe: false }, 'bulb', true, false, false],
    ['a crew', { solo: false, lightOnSwipe: true }, 'button', false, true, true],
  ])('%s', (_name, input, control, drives, lights, stoppedAfter) => {
    stopDrivingForLink();
    const run = runners();
    // The runner's own effect: a drive clears the stop as it arms.
    run.drive.mockImplementation(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
      return 'started';
    });
    const { hook } = setup(previewAfterStop(input), run);
    act(() => hook.result.current.press(control));
    expect(run.drive).toHaveBeenCalledTimes(drives ? 1 : 0);
    if (drives) expect(run.drive).toHaveBeenCalledWith('tap');
    expect(run.light).toHaveBeenCalledTimes(lights ? 1 : 0);
    expect(isDrivingStoppedForLink()).toBe(stoppedAfter);
    expect(getDriveMode() !== null).toBe(drives);
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledOnce();
  });

  it('lights as before, with the stop dropped, where the drive cannot start', () => {
    stopDrivingForLink();
    const run = runners();
    run.drive.mockReturnValue('unavailable');
    const { hook } = setup(previewAfterStop({ solo: true, lightOnSwipe: false }), run);
    act(() => hook.result.current.press('button'));
    expect(run.drive).toHaveBeenCalledOnce();
    expect(run.light).toHaveBeenCalledOnce();
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  it('starts the drive instead of lighting again on the wall with no link', () => {
    const run = runners();
    const model = resolveWallControl({
      ...PREVIEW_AFTER_STOP,
      commitButton: null,
      pressAction: 'connect',
      localConnected: false,
      displayedIsWallClimb: true,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
      solo: true,
      lightOnSwipe: false,
    });
    expect(model.state).toBe('on_wall_unlinked');
    const { hook } = setup(model, run);
    act(() => hook.result.current.press('button'));
    expect(run.drive).toHaveBeenCalledOnce();
    expect(run.lightAgain).not.toHaveBeenCalled();
  });
});
